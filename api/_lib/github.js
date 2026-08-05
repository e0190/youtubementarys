// Server-side GitHub Contents API client.
//
// The token lives in the GITHUB_TOKEN environment variable and never leaves the
// server. Browsers talk to our own /api routes; only this module talks to
// GitHub.

import { HttpError } from './http.js';

const API = 'https://api.github.com';

export const config = {
  get owner() { return process.env.GITHUB_OWNER || 'e0190'; },
  get repo() { return process.env.GITHUB_REPO || 'youtubementarys'; },
  get branch() { return process.env.GITHUB_BRANCH || 'main'; },
  get token() { return process.env.GITHUB_TOKEN || ''; },
};

export const isConfigured = () => Boolean(config.token);

function requireToken() {
  if (!config.token) {
    throw new HttpError(503, 'Storage is not configured. Set GITHUB_TOKEN in the environment.');
  }
}

function headers(extra = {}) {
  return {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'youtubementries',
    Authorization: `Bearer ${config.token}`,
    ...extra,
  };
}

const contentsUrl = (path) =>
  `${API}/repos/${config.owner}/${config.repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}`;

/** In-process cache. Warm instances reuse it; cold starts just refetch. */
const cache = new Map();
const CACHE_MS = 10_000;

/** Read a JSON file. Returns `{ data, sha }`; data is null when absent. */
export async function readJSON(path, { fresh = false } = {}) {
  requireToken();

  if (!fresh) {
    const hit = cache.get(path);
    if (hit && Date.now() - hit.at < CACHE_MS) return { data: hit.data, sha: hit.sha };
  }

  const res = await fetch(`${contentsUrl(path)}?ref=${encodeURIComponent(config.branch)}`, {
    headers: headers(),
    cache: 'no-store',
  });

  if (res.status === 404) return { data: null, sha: null };
  if (res.status === 401 || res.status === 403) {
    const detail = await safeMessage(res);
    throw new HttpError(502, `GitHub rejected the request: ${detail}`);
  }
  if (!res.ok) throw new HttpError(502, `GitHub read failed (${res.status}).`);

  const body = await res.json();
  const text = body.content
    ? Buffer.from(body.content, 'base64').toString('utf8')
    : await readBlob(body.git_url);

  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new HttpError(500, `${path} is not valid JSON: ${err.message}`);
  }

  cache.set(path, { data, sha: body.sha, at: Date.now() });
  return { data, sha: body.sha };
}

async function readBlob(gitUrl) {
  const res = await fetch(gitUrl, { headers: headers() });
  if (!res.ok) throw new HttpError(502, `GitHub blob read failed (${res.status}).`);
  const body = await res.json();
  return Buffer.from(body.content, 'base64').toString('utf8');
}

async function safeMessage(res) {
  try { return (await res.json()).message || res.statusText; } catch { return res.statusText; }
}

/** Write a JSON file. Returns the new sha. */
export async function writeJSON(path, data, { message, sha } = {}) {
  requireToken();

  const body = {
    message: message || `Update ${path}`,
    content: Buffer.from(`${JSON.stringify(data, null, 2)}\n`, 'utf8').toString('base64'),
    branch: config.branch,
  };
  if (sha) body.sha = sha;

  const res = await fetch(contentsUrl(path), {
    method: 'PUT',
    headers: headers({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    cache.delete(path);
    const detail = await safeMessage(res);
    // 409/422 mean our sha was stale — surfaced so updateJSON can retry.
    throw new HttpError(res.status === 409 || res.status === 422 ? 409 : 502,
      `GitHub write failed: ${detail}`);
  }

  const out = await res.json();
  cache.set(path, { data, sha: out.content.sha, at: Date.now() });
  return out.content.sha;
}

/**
 * Read-modify-write with retries on sha conflicts.
 *
 * `mutate(current)` must be pure and idempotent — on a conflict it is re-run
 * against freshly-read contents.
 */
export async function updateJSON(path, mutate, { message, fallback = null, retries = 4 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const { data, sha } = await readJSON(path, { fresh: attempt > 0 });
      const next = await mutate(data === null ? structuredClone(fallback) : structuredClone(data));
      if (next === undefined) return null;
      const newSha = await writeJSON(path, next, { message, sha });
      return { data: next, sha: newSha };
    } catch (err) {
      lastErr = err;
      if (err.status === 409) {
        cache.delete(path);
        await new Promise((r) => setTimeout(r, 120 * (attempt + 1) + Math.random() * 180));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

export async function deleteFile(path, message) {
  requireToken();
  const { sha } = await readJSON(path, { fresh: true });
  if (!sha) return false;
  const res = await fetch(contentsUrl(path), {
    method: 'DELETE',
    headers: headers({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ message: message || `Delete ${path}`, sha, branch: config.branch }),
  });
  cache.delete(path);
  if (res.status === 404) return false;
  if (!res.ok) throw new HttpError(502, `GitHub delete failed (${res.status}).`);
  return true;
}

export function invalidate(path) {
  if (path) cache.delete(path);
  else cache.clear();
}
