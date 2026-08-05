// Project checks: every JS file parses, every JSON file is valid, imports
// resolve, and the catalog is referentially intact.
//
//   npm run check

import { readFile, readdir, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { join, dirname, resolve as resolvePath, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';

const run = promisify(execFile);
const ROOT = fileURLToPath(new URL('..', import.meta.url));

const problems = [];
const note = (msg) => problems.push(msg);

async function walk(dir, filter, out = []) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (['node_modules', '.git', '.vercel'].includes(entry.name)) continue;
      await walk(full, filter, out);
    } else if (filter(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/* ---------- 1. syntax ---------- */

const jsFiles = [
  ...await walk(join(ROOT, 'assets/js'), (n) => n.endsWith('.js')),
  ...await walk(join(ROOT, 'api'), (n) => n.endsWith('.js')),
  ...await walk(join(ROOT, 'scripts'), (n) => n.endsWith('.mjs')),
  join(ROOT, 'sw.js'),
];

const tmp = await mkdtemp(join(tmpdir(), 'ym-check-'));
for (const file of jsFiles) {
  if (!existsSync(file)) continue;
  const copy = join(tmp, `${relative(ROOT, file).replace(/[\\/]/g, '_')}.mjs`);
  await writeFile(copy, await readFile(file));
  try {
    await run(process.execPath, ['--check', copy]);
  } catch (err) {
    const detail = String(err.stderr || err.message).split('\n').slice(0, 4).join('\n');
    note(`syntax: ${relative(ROOT, file)}\n${detail}`);
  }
}
await rm(tmp, { recursive: true, force: true });

/* ---------- 2. imports resolve ---------- */

for (const file of jsFiles) {
  if (!existsSync(file)) continue;
  const source = await readFile(file, 'utf8');
  const specifiers = [...source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
  for (const spec of specifiers) {
    if (!spec.startsWith('.')) continue; // node: builtins and bare imports
    const target = resolvePath(dirname(file), spec);
    if (!existsSync(target)) {
      note(`import: ${relative(ROOT, file)} → "${spec}" does not exist`);
    }
  }
}

/* ---------- 3. JSON validity ---------- */

const jsonFiles = [
  ...await walk(join(ROOT, 'data'), (n) => n.endsWith('.json')),
  join(ROOT, 'package.json'),
  join(ROOT, 'vercel.json'),
  join(ROOT, 'manifest.webmanifest'),
];

const parsed = {};
for (const file of jsonFiles) {
  if (!existsSync(file)) continue;
  try {
    parsed[relative(ROOT, file).replace(/\\/g, '/')] = JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    note(`json: ${relative(ROOT, file)} — ${err.message}`);
  }
}

/* ---------- 4. catalog integrity ---------- */

const channels = parsed['data/channels.json']?.channels || [];
const videos = parsed['data/videos.json']?.videos || [];
const series = parsed['data/series.json']?.series || [];
const playlists = parsed['data/playlists.json']?.playlists || [];

const channelIds = new Set(channels.map((c) => c.id));
const videoIds = new Set(videos.map((v) => v.id));
const seriesIds = new Set(series.map((s) => s.id));

const duplicates = (list, label) => {
  const seen = new Set();
  for (const item of list) {
    if (seen.has(item.id)) note(`catalog: duplicate ${label} id ${item.id}`);
    seen.add(item.id);
  }
};
duplicates(channels, 'channel');
duplicates(videos, 'video');
duplicates(series, 'series');
duplicates(playlists, 'playlist');

for (const v of videos) {
  if (!channelIds.has(v.channelId)) note(`catalog: video ${v.id} → missing channel ${v.channelId}`);
  if (v.seriesId && !seriesIds.has(v.seriesId)) note(`catalog: video ${v.id} → missing series ${v.seriesId}`);
  if (!v.durationSec) note(`catalog: video ${v.id} has no duration`);
  if (v.source?.type === 'youtube' && !/^[\w-]{11}$/.test(v.source.youtubeId || '')) {
    note(`catalog: video ${v.id} has an invalid YouTube id`);
  }
  if (v.source?.type === 'file' && !/^https?:\/\//.test(v.source.src || '')) {
    note(`catalog: video ${v.id} has an invalid file src`);
  }
}

for (const s of series) {
  if (!channelIds.has(s.channelId)) note(`catalog: series ${s.id} → missing channel ${s.channelId}`);
  for (const season of s.seasons || []) {
    for (const epId of season.episodes || []) {
      if (!videoIds.has(epId)) note(`catalog: series ${s.id} S${season.number} → missing episode ${epId}`);
      else if (videos.find((v) => v.id === epId)?.seriesId !== s.id) {
        note(`catalog: episode ${epId} listed under ${s.id} but its seriesId differs`);
      }
    }
  }
}

for (const p of playlists) {
  if (p.channelId && !channelIds.has(p.channelId)) note(`catalog: playlist ${p.id} → missing channel ${p.channelId}`);
  for (const vid of p.videoIds || []) {
    if (!videoIds.has(vid)) note(`catalog: playlist ${p.id} → missing video ${vid}`);
  }
}

/* ---------- 5. no credentials in client code ---------- */

for (const file of jsFiles.filter((f) => f.includes(`assets${'/'}js`) || f.includes(`assets\\js`))) {
  if (!existsSync(file)) continue;
  const source = await readFile(file, 'utf8');
  for (const pattern of [/gh[pousr]_[A-Za-z0-9]{20,}/, /github_pat_[A-Za-z0-9_]{20,}/, /AIza[0-9A-Za-z_-]{30,}/]) {
    if (pattern.test(source)) note(`secret: ${relative(ROOT, file)} contains what looks like a credential`);
  }
  if (/api\.github\.com/.test(source)) {
    note(`secret: ${relative(ROOT, file)} talks to the GitHub API directly — that belongs on the server`);
  }
}

/* ---------- report ---------- */

if (problems.length) {
  console.error(`\n✕ ${problems.length} problem${problems.length === 1 ? '' : 's'}:\n`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}

console.log(`✓ ${jsFiles.length} JS files parse, imports resolve, `
  + `${channels.length} channels / ${videos.length} videos / ${series.length} series / ${playlists.length} playlists are consistent.`);
