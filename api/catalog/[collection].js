// Catalog CRUD: /api/catalog/videos, /channels, /series, /playlists
//
// GET is public. Writes follow ownership rather than a blanket admin check:
// anyone signed in can post videos to their own channel and edit or delete
// what they posted. Administrators can touch anything, and only they can
// create the shared structures (other people's channels, series, published
// playlists).

import { route, json, readJsonBody, query, badRequest, notFound, forbidden } from '../_lib/http.js';
import { requireSession, requireAdmin, isAdmin } from '../_lib/auth.js';
import { readJSON, updateJSON } from '../_lib/storage.js';
import { ensureChannel, channelIdFor, ownsChannel } from '../_lib/channels.js';

const COLLECTIONS = {
  videos: { path: 'data/videos.json', key: 'videos' },
  channels: { path: 'data/channels.json', key: 'channels' },
  series: { path: 'data/series.json', key: 'series' },
  playlists: { path: 'data/playlists.json', key: 'playlists' },
};

function collectionOf(req) {
  const name = String(req.query?.collection ?? query(req).collection ?? '').trim();
  const found = COLLECTIONS[name];
  if (!found) throw notFound(`Unknown collection "${name}".`);
  return { name, ...found };
}

/* ---------- validation ---------- */

const text = (v, max) => String(v ?? '').trim().slice(0, max);
const num = (v, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) => {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : 0;
};
const list = (v, max = 200, len = 120) =>
  (Array.isArray(v) ? v : []).filter((x) => typeof x === 'string' && x.length <= len).slice(0, max);

const ID_RE = /^[\w-]{1,80}$/;

function requireId(value, label) {
  const id = text(value, 80);
  if (!ID_RE.test(id)) throw badRequest(`${label} must be letters, numbers, dashes or underscores.`);
  return id;
}

/** Only http(s) URLs — keeps javascript: and data: out of src/href attributes. */
function urlOrNull(value, label) {
  const raw = text(value, 1000);
  if (!raw) return null;
  let parsed;
  try { parsed = new URL(raw); } catch { throw badRequest(`${label} is not a valid URL.`); }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw badRequest(`${label} must be an http or https URL.`);
  }
  return parsed.toString();
}

function cleanVideo(body) {
  const src = urlOrNull(body.source?.src, 'Video URL');
  if (!src) throw badRequest('A video file is required.');

  const source = { type: 'file', src };
  const poster = urlOrNull(body.source?.poster, 'Thumbnail URL');
  if (poster) source.poster = poster;

  const captions = (Array.isArray(body.source?.captions) ? body.source.captions : [])
    .slice(0, 12)
    .map((c) => ({
      lang: text(c.lang, 12) || 'en',
      label: text(c.label, 60) || 'Subtitles',
      src: urlOrNull(c.src, 'Caption URL'),
    }))
    .filter((c) => c.src);
  if (captions.length) source.captions = captions;

  const title = text(body.title, 200);
  if (!title) throw badRequest('A title is required.');

  const durationSec = num(body.durationSec, { max: 24 * 3600 });
  if (!durationSec) throw badRequest('A duration is required.');

  const out = {
    id: requireId(body.id, 'Video id'),
    title,
    channelId: requireId(body.channelId, 'Channel id'),
    description: text(body.description, 5000),
    publishedAt: text(body.publishedAt, 40) || new Date().toISOString().slice(0, 10),
    durationSec,
    topics: list(body.topics, 20, 40),
    tags: list(body.tags, 40, 40),
    views: num(body.views),
    likes: num(body.likes),
    source,
  };

  const thumbnail = urlOrNull(body.thumbnail, 'Thumbnail URL');
  if (thumbnail) out.thumbnail = thumbnail;
  if (body.seriesId) {
    out.seriesId = requireId(body.seriesId, 'Series id');
    if (body.season) out.season = num(body.season, { min: 1, max: 100 });
    if (body.episode) out.episode = num(body.episode, { min: 1, max: 1000 });
  }
  if (body.year) out.year = num(body.year, { min: 1800, max: 2200 });
  const rating = text(body.rating, 12);
  if (rating) out.rating = rating;
  return out;
}

function cleanChannel(body) {
  const name = text(body.name, 80);
  if (!name) throw badRequest('A channel name is required.');
  return {
    id: requireId(body.id, 'Channel id'),
    handle: text(body.handle, 40).toLowerCase().replace(/[^a-z0-9_-]/g, ''),
    name,
    tagline: text(body.tagline, 160),
    description: text(body.description, 3000),
    avatar: urlOrNull(body.avatar, 'Avatar URL'),
    banner: urlOrNull(body.banner, 'Banner URL'),
    verified: Boolean(body.verified),
    subscribers: num(body.subscribers),
    joined: text(body.joined, 40) || new Date().toISOString().slice(0, 10),
    topics: list(body.topics, 20, 40),
    links: (Array.isArray(body.links) ? body.links : []).slice(0, 10)
      .map((l) => ({ label: text(l.label, 60), url: urlOrNull(l.url, 'Link URL') }))
      .filter((l) => l.url),
    ...(body.ownerId ? { ownerId: requireId(body.ownerId, 'Owner id') } : {}),
  };
}

function cleanSeries(body) {
  const title = text(body.title, 160);
  if (!title) throw badRequest('A series title is required.');
  return {
    id: requireId(body.id, 'Series id'),
    title,
    channelId: requireId(body.channelId, 'Channel id'),
    description: text(body.description, 3000),
    poster: urlOrNull(body.poster, 'Poster URL'),
    backdrop: urlOrNull(body.backdrop, 'Backdrop URL'),
    topics: list(body.topics, 20, 40),
    seasons: (Array.isArray(body.seasons) ? body.seasons : []).slice(0, 50).map((s, i) => ({
      number: num(s.number, { min: 1, max: 100 }) || i + 1,
      title: text(s.title, 100) || `Season ${i + 1}`,
      episodes: list(s.episodes, 500),
    })),
  };
}

function cleanPlaylist(body) {
  const title = text(body.title, 120);
  if (!title) throw badRequest('A playlist title is required.');
  return {
    id: requireId(body.id, 'Playlist id'),
    title,
    description: text(body.description, 1000),
    channelId: body.channelId ? requireId(body.channelId, 'Channel id') : null,
    videoIds: list(body.videoIds, 500),
    visibility: 'public',
  };
}

const CLEANERS = {
  videos: cleanVideo,
  channels: cleanChannel,
  series: cleanSeries,
  playlists: cleanPlaylist,
};

/* ---------- authorisation ---------- */

/** Can `session` create or overwrite this record? */
async function authoriseWrite(name, record, session, existing) {
  if (isAdmin(session)) return record;

  if (name === 'videos') {
    // Posting is open, but only onto your own channel — and editing is limited
    // to what you posted. Both checks matter: without the second, anyone could
    // overwrite someone else's video by reusing its id.
    if (existing && existing.channelId !== channelIdFor(session.sub)) {
      throw forbidden('That video belongs to someone else.');
    }
    const channel = await ensureChannel(session);
    return { ...record, channelId: channel.id };
  }

  if (name === 'channels') {
    if (!ownsChannel(session, record.id)) {
      throw forbidden('You can only edit your own channel.');
    }
    // Reserved fields stay as they were, whatever the request said.
    return {
      ...record,
      verified: existing?.verified ?? false,
      subscribers: existing?.subscribers ?? 0,
      ownerId: session.sub,
    };
  }

  throw forbidden(`Only administrators can change ${name}.`);
}

function authoriseDelete(name, existing, session) {
  if (isAdmin(session)) return;
  if (name === 'videos' && existing.channelId === channelIdFor(session.sub)) return;
  if (name === 'channels' && ownsChannel(session, existing.id)) return;
  throw forbidden('That isn’t yours to delete.');
}

/* ---------- handler ---------- */

export default route(async (req, res) => {
  const { name, path, key } = collectionOf(req);

  if (req.method === 'GET') {
    const { data } = await readJSON(path);
    json(res, 200, { [key]: data?.[key] || [] });
    return;
  }

  // Series and published playlists stay curated; videos and channels are open
  // to their owners.
  const session = (name === 'series' || name === 'playlists')
    ? requireAdmin(req)
    : requireSession(req);

  const body = await readJsonBody(req);

  if (req.method === 'DELETE') {
    const id = requireId(body.id, 'Id');
    const { data: current } = await readJSON(path, { fresh: true });
    const existing = (current?.[key] || []).find((x) => x.id === id);
    if (!existing) throw notFound('That item no longer exists.');
    authoriseDelete(name, existing, session);

    await updateJSON(path, (data) => {
      const items = data?.[key] || [];
      if (!items.some((x) => x.id === id)) return undefined;
      return { ...(data || {}), [key]: items.filter((x) => x.id !== id) };
    }, { message: `catalog: remove ${name} ${id} (${session.email})`, fallback: { [key]: [] } });

    json(res, 200, { ok: true, id });
    return;
  }

  // POST — upsert
  const draft = CLEANERS[name](body);
  const { data: current } = await readJSON(path, { fresh: true });
  const existing = (current?.[key] || []).find((x) => x.id === draft.id);
  const record = await authoriseWrite(name, draft, session, existing);

  const { data } = await updateJSON(path, (state) => {
    const items = state?.[key] || [];
    const i = items.findIndex((x) => x.id === record.id);
    const next = items.slice();
    if (i >= 0) next[i] = record;
    else next.unshift(record);
    return { ...(state || {}), [key]: next };
  }, { message: `catalog: save ${name} ${record.id} (${session.email})`, fallback: { [key]: [] } });

  json(res, 200, { item: record, count: data[key].length });
}, { methods: ['GET', 'POST', 'DELETE'] });
