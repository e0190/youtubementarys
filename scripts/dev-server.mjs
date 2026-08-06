// Local development server.
//
// Serves the static site and mounts everything under api/ the way Vercel does,
// including [param] segments, so the app can be exercised end to end without
// the Vercel CLI. Not used in production.
//
//   node scripts/dev-server.mjs [--port 8500]
//
// Reads .env.local (KEY=value per line) if present.

import { createServer } from 'node:http';
import { readFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, extname, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const API_DIR = join(ROOT, 'api');

const argPort = process.argv.indexOf('--port');
const PORT = Number(argPort > -1 ? process.argv[argPort + 1] : 0) || Number(process.env.PORT) || 8500;

/* ---------- env ---------- */

async function loadEnv() {
  const file = join(ROOT, '.env.local');
  if (!existsSync(file)) return [];
  const loaded = [];
  for (const line of (await readFile(file, 'utf8')).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const i = trimmed.indexOf('=');
    if (i < 0) continue;
    const key = trimmed.slice(0, i).trim();
    let value = trimmed.slice(i + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
    loaded.push(key);
  }
  return loaded;
}

/* ---------- route table ---------- */

/**
 * Walk api/ and build routes the way Vercel's filesystem router does.
 * `_`-prefixed files are shared libraries, not endpoints.
 */
async function buildRoutes(dir = API_DIR, prefix = '/api') {
  const routes = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return routes;
  }

  for (const entry of entries) {
    if (entry.name.startsWith('_')) continue;
    const full = join(dir, entry.name);

    if (entry.isDirectory()) {
      routes.push(...await buildRoutes(full, `${prefix}/${entry.name}`));
      continue;
    }
    if (!entry.name.endsWith('.js') && !entry.name.endsWith('.mjs')) continue;

    const base = entry.name.replace(/\.m?js$/, '');
    const segment = base === 'index' ? '' : `/${base}`;
    const pattern = `${prefix}${segment}` || '/';

    const params = [];
    const regexSource = pattern
      .split('/')
      .map((part) => {
        const dynamic = part.match(/^\[(\.\.\.)?(\w+)\]$/);
        if (!dynamic) return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        params.push(dynamic[2]);
        return dynamic[1] ? '(.+)' : '([^/]+)';
      })
      .join('/');

    routes.push({ regex: new RegExp(`^${regexSource}/?$`), params, file: full, pattern });
  }

  // Static segments beat dynamic ones, so /api/catalog/videos wins over
  // /api/catalog/[collection] if both ever exist.
  return routes.sort((a, b) => a.params.length - b.params.length);
}

/* ---------- static files ---------- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

async function serveStatic(res, pathname) {
  const clean = decodeURIComponent(pathname).replace(/^\/+/, '');

  // When running on local storage, /data/*.json must come from there — otherwise
  // Studio would write to .dev-storage while the app kept reading the repo's
  // copy, and edits would appear to do nothing.
  const storageDir = process.env.YM_LOCAL_STORAGE_DIR;
  if (storageDir && clean.startsWith('data/')) {
    const shadowed = join(storageDir, clean);
    if (existsSync(shadowed)) return sendFile(res, shadowed);
  }

  let filePath = join(ROOT, clean);

  // Refuse anything that escapes the project directory.
  if (relative(ROOT, filePath).startsWith('..' + sep)) {
    res.statusCode = 403;
    res.end('Forbidden');
    return true;
  }

  try {
    const info = await stat(filePath);
    if (info.isDirectory()) filePath = join(filePath, 'index.html');
  } catch {
    return false;
  }

  try {
    const body = await readFile(filePath);
    res.statusCode = 200;
    res.setHeader('Content-Type', MIME[extname(filePath).toLowerCase()] || 'application/octet-stream');
    // No caching locally — module caching makes edits invisible otherwise.
    res.setHeader('Cache-Control', 'no-store, must-revalidate');
    res.end(body);
    return true;
  } catch {
    return false;
  }
}

/* ---------- server ---------- */

const loadedEnv = await loadEnv();
// Session cookies must work over http://localhost.
process.env.YM_INSECURE_COOKIES = '1';

/**
 * Without a GITHUB_TOKEN, persist to .dev-storage/ instead so sign-up, Studio
 * and comments can all be exercised locally without writing to the real repo.
 * The catalog is seeded from data/ on first run.
 */
if (!process.env.GITHUB_TOKEN && !process.env.YM_LOCAL_STORAGE_DIR) {
  const storageDir = join(ROOT, '.dev-storage');
  process.env.YM_LOCAL_STORAGE_DIR = storageDir;

  const { mkdir, copyFile } = await import('node:fs/promises');
  await mkdir(join(storageDir, 'data'), { recursive: true });
  for (const name of ['channels.json', 'videos.json', 'series.json', 'playlists.json', 'stats.json']) {
    const target = join(storageDir, 'data', name);
    if (!existsSync(target) && existsSync(join(ROOT, 'data', name))) {
      await copyFile(join(ROOT, 'data', name), target);
    }
  }
}

const routes = await buildRoutes();

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const started = Date.now();

  res.on('finish', () => {
    const code = res.statusCode;
    const colour = code >= 500 ? '\x1b[31m' : code >= 400 ? '\x1b[33m' : '\x1b[32m';
    console.log(`${colour}${code}\x1b[0m ${req.method.padEnd(6)} ${url.pathname}${url.search} ${Date.now() - started}ms`);
  });

  if (url.pathname.startsWith('/api')) {
    const match = routes.find((r) => r.regex.test(url.pathname));
    if (!match) {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: `No API route for ${url.pathname}` }));
      return;
    }

    const values = url.pathname.match(match.regex).slice(1);
    req.query = {
      ...Object.fromEntries(url.searchParams),
      ...Object.fromEntries(match.params.map((name, i) => [name, decodeURIComponent(values[i])])),
    };

    try {
      // Cache-bust so edits to handlers are picked up without a restart.
      const mod = await import(`${pathToFileURL(match.file).href}?t=${Date.now()}`);
      await mod.default(req, res);
    } catch (err) {
      console.error(`\x1b[31m[api]\x1b[0m ${url.pathname}`, err);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: err.message }));
      }
    }
    return;
  }

  if (await serveStatic(res, url.pathname)) return;

  // Everything else falls through to the app shell, matching vercel.json.
  if (await serveStatic(res, '/index.html')) return;

  res.statusCode = 404;
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`\n  YoutubeMentries dev server`);
  console.log(`  http://localhost:${PORT}\n`);
  console.log(`  ${routes.length} API routes:`);
  for (const r of routes) console.log(`    ${r.pattern}`);
  console.log(`\n  storage: ${process.env.YM_LOCAL_STORAGE_DIR ? '.dev-storage/ (local files)' : 'GitHub'}`);
  console.log(loadedEnv.length
    ? `  .env.local: ${loadedEnv.join(', ')}\n`
    : '  No .env.local — auth will report as unconfigured.\n');
});
