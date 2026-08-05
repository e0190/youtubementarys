// Catalog CRUD: /api/catalog/videos, /channels, /series, /playlists
//
// GET is public. POST (upsert) and DELETE require an admin session, so the
// browser no longer needs — and can no longer hold — a GitHub token.

import { route, json, readJsonBody, query, badRequest, notFound } from '../_lib/http.js';
import { requireAdmin } from '../_lib/auth.js';
import { readJSON, updateJSON } from '../_lib/github.js';

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
const YT_RE = /^[\w-]{11}$/;

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
  const type = body.source?.type === 'file' ? 'file' : 'youtube';
  let source;
  if (type === 'youtube') {
    const ytId = text(body.source?.youtubeId, 20);
    if (!YT_RE.test(ytId)) throw badRequest('That is not a valid YouTube video id.');
    source = { type: 'youtube', youtubeId: ytId };
  } else {
    const src = urlOrNull(body.source?.src, 'Video file URL');
    if (!src) throw badRequest('A video file URL is required.');
    source = { type: 'file', src };
    const poster = urlOrNull(body.source?.poster, 'Poster URL');
    if (poster) source.poster = poster;
    const captions = (Array.isArray(body.source?.captions) ? body.source.captions : [])
      .slice(0, 12)
      .map((c) => ({ lang: text(c.lang, 12) || 'en', label: text(c.label, 60) || 'Subtitles', src: urlOrNull(c.src, 'Caption URL') }))
      .filter((c) => c.src);
    if (captions.length) source.captions = captions;
  }

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

/* ---------- handler ---------- */

export default route(async (req, res) => {
  const { name, path, key } = collectionOf(req);

  if (req.method === 'GET') {
    const { data } = await readJSON(path);
    json(res, 200, { [key]: data?.[key] || [] });
    return;
  }

  const session = requireAdmin(req);
  const body = await readJsonBody(req);

  if (req.method === 'DELETE') {
    const id = requireId(body.id, 'Id');
    let removed = false;
    await updateJSON(path, (data) => {
      const items = data?.[key] || [];
      if (!items.some((x) => x.id === id)) return undefined;
      removed = true;
      return { ...(data || {}), [key]: items.filter((x) => x.id !== id) };
    }, { message: `studio: remove ${name} ${id} (${session.email})`, fallback: { [key]: [] } });

    if (!removed) throw notFound('That item no longer exists.');
    json(res, 200, { ok: true, id });
    return;
  }

  // POST — upsert
  const record = CLEANERS[name](body);
  const { data } = await updateJSON(path, (current) => {
    const items = current?.[key] || [];
    const i = items.findIndex((x) => x.id === record.id);
    const next = items.slice();
    if (i >= 0) next[i] = record;
    else next.unshift(record);
    return { ...(current || {}), [key]: next };
  }, { message: `studio: save ${name} ${record.id} (${session.email})`, fallback: { [key]: [] } });

  json(res, 200, { item: record, count: data[key].length });
}, { methods: ['GET', 'POST', 'DELETE'] });
