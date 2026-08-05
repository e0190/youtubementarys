// The signed-in viewer's own data: subscriptions, history, resume positions,
// ratings, playlists, watch later.
//
// GET  returns the stored record (creating an empty one on first call).
// PUT  replaces it. The client is the source of truth for its own profile and
//      pushes debounced snapshots, so last-write-wins across devices is the
//      intended behaviour.

import { route, json, readJsonBody, badRequest } from './_lib/http.js';
import { requireSession } from './_lib/auth.js';
import { readJSON, writeJSON } from './_lib/github.js';

const path = (userId) => `data/users/${userId}.json`;

const HISTORY_LIMIT = 500;
const PLAYLIST_LIMIT = 200;
const LIST_LIMIT = 1000;

function emptyRecord(session) {
  return {
    id: session.sub,
    name: session.name || 'Viewer',
    avatar: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    subscriptions: [],
    history: [],
    ratings: {},
    playlists: [],
    watchLater: [],
  };
}

const str = (v, max = 200) => String(v ?? '').slice(0, max);
const ids = (v, max = LIST_LIMIT) =>
  (Array.isArray(v) ? v : []).filter((x) => typeof x === 'string' && x.length <= 120).slice(0, max);

/**
 * Accept only the fields we store, with sane bounds. The body is user input, so
 * nothing is written back to the repo unvalidated.
 */
function sanitise(body, existing, session) {
  const base = existing || emptyRecord(session);

  const history = (Array.isArray(body.history) ? body.history : [])
    .filter((h) => h && typeof h.videoId === 'string')
    .slice(0, HISTORY_LIMIT)
    .map((h) => ({
      videoId: str(h.videoId, 120),
      position: Math.max(0, Math.floor(Number(h.position) || 0)),
      duration: Math.max(0, Math.floor(Number(h.duration) || 0)),
      updatedAt: str(h.updatedAt, 40) || new Date().toISOString(),
      completed: Boolean(h.completed),
    }));

  const ratings = {};
  for (const [key, value] of Object.entries(body.ratings || {})) {
    if (typeof key !== 'string' || key.length > 120) continue;
    if (value === 1 || value === -1) ratings[key] = value;
    if (Object.keys(ratings).length >= LIST_LIMIT) break;
  }

  const playlists = (Array.isArray(body.playlists) ? body.playlists : [])
    .slice(0, PLAYLIST_LIMIT)
    .filter((p) => p && typeof p.id === 'string')
    .map((p) => ({
      id: str(p.id, 60),
      title: str(p.title, 100) || 'Untitled playlist',
      description: str(p.description, 1000),
      visibility: p.visibility === 'public' ? 'public' : 'private',
      videoIds: ids(p.videoIds, 500),
      createdAt: str(p.createdAt, 40) || new Date().toISOString(),
      updatedAt: str(p.updatedAt, 40) || new Date().toISOString(),
    }));

  return {
    ...base,
    id: session.sub,          // never client-controlled
    name: str(body.name, 40) || base.name,
    avatar: body.avatar ? str(body.avatar, 500) : base.avatar,
    subscriptions: ids(body.subscriptions),
    history,
    ratings,
    playlists,
    watchLater: ids(body.watchLater),
    updatedAt: new Date().toISOString(),
  };
}

export default route(async (req, res) => {
  const session = requireSession(req);

  if (req.method === 'GET') {
    const { data } = await readJSON(path(session.sub));
    json(res, 200, { data: data || emptyRecord(session) });
    return;
  }

  const body = await readJsonBody(req);
  if (!body || typeof body !== 'object') throw badRequest('Expected a JSON object.');

  const { data: existing, sha } = await readJSON(path(session.sub), { fresh: true });
  const record = sanitise(body, existing, session);

  await writeJSON(path(session.sub), record, {
    message: `sync: ${session.email || session.sub}`,
    sha,
  });

  json(res, 200, { data: record });
}, { methods: ['GET', 'PUT'] });
