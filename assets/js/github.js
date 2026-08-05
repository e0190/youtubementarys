// GitHub Contents API client.
//
// Reads fall back to raw.githubusercontent.com when no token is present, so the
// site is fully browsable by anonymous visitors. Writes require a token with
// `contents: read/write` on this repo.

import { REPO, LS } from './config.js';
import { b64encode, b64decode, lsGet, lsSet, lsRemove } from './util.js';

const API = 'https://api.github.com';
const RAW = 'https://raw.githubusercontent.com';

/** sha cache keyed by path — avoids a GET before every PUT. */
const shaCache = new Map();

export class GitHubError extends Error {
  constructor(message, status, path) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
    this.path = path;
  }
}

/* ---------- token ---------- */

export function getToken() {
  return lsGet(LS.token, '') || REPO.token || '';
}

export function setToken(token) {
  const t = String(token || '').trim();
  if (t) lsSet(LS.token, t);
  else lsRemove(LS.token);
  shaCache.clear();
  return t;
}

export const hasToken = () => Boolean(getToken());

/** True when the token can actually write to this repo. Also warms the sha cache. */
export async function verifyToken(token = getToken()) {
  if (!token) return { ok: false, reason: 'No token set.' };
  try {
    const res = await fetch(`${API}/repos/${REPO.owner}/${REPO.repo}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
    });
    if (res.status === 401) return { ok: false, reason: 'Token rejected (401). It may be expired or revoked.' };
    if (res.status === 404) return { ok: false, reason: 'Repo not visible to this token. Check its repository access.' };
    if (!res.ok) return { ok: false, reason: `GitHub returned ${res.status}.` };
    const repo = await res.json();
    if (!repo.permissions?.push) {
      return { ok: false, reason: 'Token can read but not write. Grant Contents: Read and write.' };
    }
    return { ok: true, login: repo.owner?.login, repo: repo.full_name };
  } catch (err) {
    return { ok: false, reason: `Network error: ${err.message}` };
  }
}

/* ---------- low level ---------- */

function headers(extra = {}) {
  const token = getToken();
  return {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...extra,
  };
}

const contentsUrl = (path) =>
  `${API}/repos/${REPO.owner}/${REPO.repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}`;

/**
 * Read a JSON file from the repo.
 * Returns `{ data, sha }`, or `{ data: null, sha: null }` when the file is absent.
 */
export async function readJSON(path, { fresh = false } = {}) {
  const token = getToken();

  if (token) {
    const res = await fetch(`${contentsUrl(path)}?ref=${encodeURIComponent(REPO.branch)}`, {
      headers: headers(),
      cache: fresh ? 'no-store' : 'default',
    });
    if (res.status === 404) return { data: null, sha: null };
    if (!res.ok) throw new GitHubError(`Read failed: ${res.status} ${res.statusText}`, res.status, path);
    const body = await res.json();
    shaCache.set(path, body.sha);
    // Files over 1 MB come back with an empty content field and must be fetched
    // from the blob endpoint instead.
    const text = body.content ? b64decode(body.content) : await readBlob(body.git_url);
    return { data: safeParse(text, path), sha: body.sha };
  }

  // Anonymous read via the raw CDN.
  const bust = fresh ? `?t=${Date.now()}` : '';
  const res = await fetch(`${RAW}/${REPO.owner}/${REPO.repo}/${REPO.branch}/${path}${bust}`, {
    cache: fresh ? 'no-store' : 'default',
  });
  if (res.status === 404) return { data: null, sha: null };
  if (!res.ok) throw new GitHubError(`Read failed: ${res.status} ${res.statusText}`, res.status, path);
  return { data: safeParse(await res.text(), path), sha: null };
}

async function readBlob(gitUrl) {
  const res = await fetch(gitUrl, { headers: headers() });
  if (!res.ok) throw new GitHubError(`Blob read failed: ${res.status}`, res.status, gitUrl);
  const body = await res.json();
  return b64decode(body.content);
}

function safeParse(text, path) {
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new GitHubError(`${path} is not valid JSON: ${err.message}`, 200, path);
  }
}

/** Fetch just the sha for a path, or null if the file doesn't exist. */
async function fetchSha(path) {
  const res = await fetch(`${contentsUrl(path)}?ref=${encodeURIComponent(REPO.branch)}`, {
    headers: headers(),
    cache: 'no-store',
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new GitHubError(`Sha lookup failed: ${res.status}`, res.status, path);
  const sha = (await res.json()).sha;
  shaCache.set(path, sha);
  return sha;
}

/**
 * Write a JSON file. Pass the `sha` you read if you have it; otherwise it is
 * looked up. Returns the new sha.
 */
export async function writeJSON(path, data, { message, sha } = {}) {
  if (!hasToken()) throw new GitHubError('A GitHub token is required to save. Add one in Settings.', 401, path);

  const body = {
    message: message || `Update ${path}`,
    content: b64encode(JSON.stringify(data, null, 2) + '\n'),
    branch: REPO.branch,
  };
  const known = sha ?? shaCache.get(path) ?? await fetchSha(path);
  if (known) body.sha = known;

  const res = await fetch(contentsUrl(path), {
    method: 'PUT',
    headers: headers({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`;
    try { detail = (await res.json()).message || detail; } catch { /* keep status text */ }
    shaCache.delete(path);
    throw new GitHubError(`Write failed: ${detail}`, res.status, path);
  }

  const out = await res.json();
  shaCache.set(path, out.content.sha);
  return out.content.sha;
}

/**
 * Read-modify-write with optimistic-concurrency retries.
 *
 * `mutate(data)` receives the current file contents (or `fallback` when the file
 * doesn't exist yet) and returns the value to write. If two clients race, the
 * loser re-reads the fresh contents and re-applies `mutate` — so keep `mutate`
 * pure and idempotent.
 */
export async function updateJSON(path, mutate, { message, fallback = null, retries = 3 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const { data, sha } = await readJSON(path, { fresh: attempt > 0 });
      const next = await mutate(structuredClone(data ?? fallback));
      if (next === undefined) return null; // mutate opted out
      const newSha = await writeJSON(path, next, { message, sha });
      return { data: next, sha: newSha };
    } catch (err) {
      lastErr = err;
      // 409 = sha conflict, 422 = stale sha. Both are retryable.
      if (err.status === 409 || err.status === 422) {
        shaCache.delete(path);
        await new Promise((r) => setTimeout(r, 200 * (attempt + 1) + Math.random() * 200));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

/** Delete a file. Resolves quietly if it was already gone. */
export async function deleteFile(path, message) {
  if (!hasToken()) throw new GitHubError('A GitHub token is required to delete.', 401, path);
  const sha = shaCache.get(path) ?? await fetchSha(path);
  if (!sha) return false;
  const res = await fetch(contentsUrl(path), {
    method: 'DELETE',
    headers: headers({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ message: message || `Delete ${path}`, sha, branch: REPO.branch }),
  });
  shaCache.delete(path);
  if (res.status === 404) return false;
  if (!res.ok) throw new GitHubError(`Delete failed: ${res.status}`, res.status, path);
  return true;
}

/** Remaining core API quota — handy for the Studio status line. */
export async function rateLimit() {
  const res = await fetch(`${API}/rate_limit`, { headers: headers() });
  if (!res.ok) return null;
  const body = await res.json();
  return body.resources?.core ?? null;
}
