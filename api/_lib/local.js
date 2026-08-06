// Filesystem storage driver — local development only.
//
// Vercel's runtime has no writable persistent disk, so this never runs in
// production. It exists so the whole app (including sign-up and Studio) can be
// exercised locally without pointing a GitHub token at the real repo.
//
// Activated by setting YM_LOCAL_STORAGE_DIR, which scripts/dev-server.mjs does.

import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname, resolve, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';

const root = () => resolve(process.env.YM_LOCAL_STORAGE_DIR);

export const isConfigured = () => Boolean(process.env.YM_LOCAL_STORAGE_DIR);

function fullPath(path) {
  const target = resolve(join(root(), path));
  // Refuse anything that climbs out of the storage directory.
  if (relative(root(), target).startsWith('..' + sep)) {
    throw new Error(`Refusing to touch ${path} outside the storage directory.`);
  }
  return target;
}

const shaOf = (text) => createHash('sha1').update(text).digest('hex');

export async function readJSON(path) {
  const file = fullPath(path);
  if (!existsSync(file)) return { data: null, sha: null };
  const text = await readFile(file, 'utf8');
  return { data: JSON.parse(text), sha: shaOf(text) };
}

export async function writeJSON(path, data) {
  const file = fullPath(path);
  await mkdir(dirname(file), { recursive: true });
  const text = `${JSON.stringify(data, null, 2)}\n`;
  await writeFile(file, text, 'utf8');
  return shaOf(text);
}

export async function updateJSON(path, mutate, { fallback = null } = {}) {
  const { data } = await readJSON(path);
  const next = await mutate(data === null ? structuredClone(fallback) : structuredClone(data));
  if (next === undefined) return null;
  const sha = await writeJSON(path, next);
  return { data: next, sha };
}

export async function deleteFile(path) {
  const file = fullPath(path);
  if (!existsSync(file)) return false;
  await unlink(file);
  return true;
}

export function invalidate() { /* no cache to clear */ }
