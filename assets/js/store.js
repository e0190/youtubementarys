// Application state: the catalog (read from data/*.json) and the viewer's own
// data (profile, subscriptions, history, likes, playlists).
//
// Everything is local-first. Mutations land in memory + localStorage
// synchronously so the UI never waits on the network; sync.js pushes them to the
// repo in the background when a token is configured.

import { PATHS, LS, DEFAULT_SETTINGS } from './config.js';
import { readJSON } from './github.js';
import { lsGet, lsSet, uid, emitter, seededShuffle } from './util.js';

export const events = emitter();

export const store = {
  ready: false,
  loadError: null,
  catalog: { channels: [], videos: [], series: [], playlists: [] },
  stats: { views: {}, likes: {}, dislikes: {} },
  // Counter changes made on this device that haven't been merged into
  // data/stats.json yet. sync.js drains this; see mergePendingStats().
  pendingStats: { views: {}, likes: {} },
  user: null,
  settings: { ...DEFAULT_SETTINGS },
  index: {
    channel: new Map(),
    handle: new Map(),
    video: new Map(),
    series: new Map(),
    playlist: new Map(),
    videosByChannel: new Map(),
    videosBySeries: new Map(),
    seriesByChannel: new Map(),
  },
};

/* ---------- boot ---------- */

function blankUser() {
  return {
    id: uid('u'),
    name: 'Guest',
    avatar: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    subscriptions: [],
    history: [],      // { videoId, position, duration, updatedAt, completed }
    ratings: {},      // videoId -> 1 | -1
    playlists: [],    // { id, title, description, videoIds, visibility, createdAt, updatedAt }
    watchLater: [],
  };
}

export function loadLocal() {
  store.settings = { ...DEFAULT_SETTINGS, ...(lsGet(LS.settings) || {}) };
  const cached = lsGet(LS.user);
  store.user = cached && cached.id ? { ...blankUser(), ...cached } : blankUser();
  if (!lsGet(LS.userId)) lsSet(LS.userId, store.user.id);

  const cachedCatalog = lsGet(LS.catalogCache);
  if (cachedCatalog?.catalog) {
    store.catalog = cachedCatalog.catalog;
    store.stats = cachedCatalog.stats || store.stats;
    reindex();
  }
  return store;
}

/** Fetch the catalog from the repo. Falls back to the localStorage cache on failure. */
export async function loadCatalog({ fresh = false } = {}) {
  const pull = async (path, key, fallback) => {
    try {
      const { data } = await readJSON(path, { fresh });
      const list = data?.[key];
      return Array.isArray(list) ? list : fallback;
    } catch (err) {
      console.warn(`[catalog] ${path}:`, err.message);
      return null; // distinguishes "failed" from "empty"
    }
  };

  const [channels, videos, series, playlists, stats] = await Promise.all([
    pull(PATHS.channels, 'channels', []),
    pull(PATHS.videos, 'videos', []),
    pull(PATHS.series, 'series', []),
    pull(PATHS.playlists, 'playlists', []),
    (async () => {
      try { return (await readJSON('data/stats.json', { fresh })).data; } catch { return null; }
    })(),
  ]);

  const anyFailed = [channels, videos, series, playlists].some((x) => x === null);
  if (anyFailed && store.catalog.videos.length) {
    store.loadError = 'Could not reach GitHub — showing the last cached catalog.';
  } else if (anyFailed) {
    store.loadError = 'Could not load the catalog. Check your connection and reload.';
  } else {
    store.loadError = null;
  }

  store.catalog = {
    channels: channels ?? store.catalog.channels,
    videos: videos ?? store.catalog.videos,
    series: series ?? store.catalog.series,
    playlists: playlists ?? store.catalog.playlists,
  };
  if (stats) store.stats = { views: {}, likes: {}, dislikes: {}, ...stats };

  reindex();
  lsSet(LS.catalogCache, { at: Date.now(), catalog: store.catalog, stats: store.stats });
  store.ready = true;
  events.emit('catalog');
  return store.catalog;
}

export function reindex() {
  const ix = store.index;
  for (const map of Object.values(ix)) map.clear();

  for (const c of store.catalog.channels) {
    ix.channel.set(c.id, c);
    if (c.handle) ix.handle.set(String(c.handle).replace(/^@/, '').toLowerCase(), c);
  }
  for (const s of store.catalog.series) {
    ix.series.set(s.id, s);
    if (!ix.seriesByChannel.has(s.channelId)) ix.seriesByChannel.set(s.channelId, []);
    ix.seriesByChannel.get(s.channelId).push(s);
  }
  for (const p of store.catalog.playlists) ix.playlist.set(p.id, p);

  for (const v of store.catalog.videos) {
    ix.video.set(v.id, v);
    if (!ix.videosByChannel.has(v.channelId)) ix.videosByChannel.set(v.channelId, []);
    ix.videosByChannel.get(v.channelId).push(v);
    if (v.seriesId) {
      if (!ix.videosBySeries.has(v.seriesId)) ix.videosBySeries.set(v.seriesId, []);
      ix.videosBySeries.get(v.seriesId).push(v);
    }
  }

  const newestFirst = (a, b) => new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0);
  for (const list of ix.videosByChannel.values()) list.sort(newestFirst);
  for (const list of ix.videosBySeries.values()) {
    list.sort((a, b) => (a.season || 0) - (b.season || 0) || (a.episode || 0) - (b.episode || 0));
  }
}

/* ---------- catalog reads ---------- */

export const getVideo = (id) => store.index.video.get(id) || null;
export const getSeries = (id) => store.index.series.get(id) || null;
export const getPlaylist = (id) => store.index.playlist.get(id) || null;

export function getChannel(idOrHandle) {
  if (!idOrHandle) return null;
  const key = String(idOrHandle).replace(/^@/, '');
  return store.index.channel.get(key) || store.index.handle.get(key.toLowerCase()) || null;
}

export const videosOfChannel = (channelId) => store.index.videosByChannel.get(channelId) || [];
export const seriesOfChannel = (channelId) => store.index.seriesByChannel.get(channelId) || [];
export const videosOfSeries = (seriesId) => store.index.videosBySeries.get(seriesId) || [];

/** Episodes grouped by season, using series.seasons when present. */
export function seasonsOf(seriesId) {
  const series = getSeries(seriesId);
  const episodes = videosOfSeries(seriesId);
  if (series?.seasons?.length) {
    return series.seasons.map((s) => ({
      number: s.number,
      title: s.title || `Season ${s.number}`,
      episodes: (s.episodes || []).map(getVideo).filter(Boolean),
    })).filter((s) => s.episodes.length);
  }
  const grouped = new Map();
  for (const v of episodes) {
    const n = v.season || 1;
    if (!grouped.has(n)) grouped.set(n, []);
    grouped.get(n).push(v);
  }
  return [...grouped.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([number, eps]) => ({ number, title: `Season ${number}`, episodes: eps }));
}

/** Resolve the videos a playlist points at, skipping ids that no longer exist. */
export const playlistVideos = (playlist) =>
  (playlist?.videoIds || []).map(getVideo).filter(Boolean);

export function thumbnailFor(video) {
  if (!video) return null;
  if (video.thumbnail) return video.thumbnail;
  if (video.source?.type === 'youtube' && video.source.youtubeId) {
    return `https://i.ytimg.com/vi/${video.source.youtubeId}/maxresdefault.jpg`;
  }
  return video.source?.poster || null;
}

/** Lower-res YouTube thumb that always exists — used as an onerror fallback. */
export function thumbnailFallback(video) {
  if (video?.source?.type === 'youtube' && video.source.youtubeId) {
    return `https://i.ytimg.com/vi/${video.source.youtubeId}/mqdefault.jpg`;
  }
  return null;
}

export const viewsOf = (video) => (video?.views || 0) + (store.stats.views?.[video?.id] || 0);
export const likesOf = (video) => (video?.likes || 0) + (store.stats.likes?.[video?.id] || 0);

/* ---------- search & discovery ---------- */

function scoreMatch(video, terms) {
  const channel = getChannel(video.channelId);
  const haystacks = [
    [video.title, 6],
    [channel?.name, 3],
    [(video.topics || []).join(' '), 3],
    [(video.tags || []).join(' '), 2],
    [video.description, 1],
  ];
  let score = 0;
  for (const term of terms) {
    let hit = 0;
    for (const [text, weight] of haystacks) {
      if (text && String(text).toLowerCase().includes(term)) hit = Math.max(hit, weight);
    }
    if (!hit) return 0; // every term must match something
    score += hit;
  }
  return score;
}

export function searchVideos(query, { sort = 'relevance', topic = null, type = null, length = null } = {}) {
  const terms = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  let results = store.catalog.videos.map((v) => ({ v, score: terms.length ? scoreMatch(v, terms) : 1 }))
    .filter((r) => r.score > 0)
    .map((r) => r.v);

  if (topic) results = results.filter((v) => (v.topics || []).includes(topic));
  if (type === 'series') results = results.filter((v) => v.seriesId);
  if (type === 'film') results = results.filter((v) => !v.seriesId);
  if (length === 'short') results = results.filter((v) => (v.durationSec || 0) < 20 * 60);
  if (length === 'medium') results = results.filter((v) => (v.durationSec || 0) >= 20 * 60 && (v.durationSec || 0) < 60 * 60);
  if (length === 'long') results = results.filter((v) => (v.durationSec || 0) >= 60 * 60);

  const sorters = {
    relevance: (a, b) => (terms.length
      ? scoreMatch(b, terms) - scoreMatch(a, terms) || viewsOf(b) - viewsOf(a)
      : viewsOf(b) - viewsOf(a)),
    newest: (a, b) => new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0),
    views: (a, b) => viewsOf(b) - viewsOf(a),
    rating: (a, b) => likesOf(b) - likesOf(a),
  };
  return results.sort(sorters[sort] || sorters.relevance);
}

export function searchChannels(query) {
  const q = String(query || '').toLowerCase().trim();
  if (!q) return [];
  return store.catalog.channels.filter((c) =>
    c.name.toLowerCase().includes(q) ||
    String(c.handle || '').toLowerCase().includes(q) ||
    (c.topics || []).some((t) => t.toLowerCase().includes(q)));
}

export function searchSeries(query) {
  const q = String(query || '').toLowerCase().trim();
  if (!q) return [];
  return store.catalog.series.filter((s) =>
    s.title.toLowerCase().includes(q) ||
    (s.topics || []).some((t) => t.toLowerCase().includes(q)));
}

/** Home feed: subscriptions and continue-watching float up, then popularity. */
export function homeFeed(topic = null) {
  let pool = store.catalog.videos.slice();
  if (topic && topic !== 'All') pool = pool.filter((v) => (v.topics || []).includes(topic));

  const subs = new Set(store.user.subscriptions);
  const seen = new Set(store.user.history.filter((h) => h.completed).map((h) => h.videoId));

  return pool.map((v) => {
    let weight = Math.log10(viewsOf(v) + 10);
    if (subs.has(v.channelId)) weight += 4;
    if (seen.has(v.id)) weight -= 6;
    const ageDays = (Date.now() - new Date(v.publishedAt || 0)) / 86400000;
    if (ageDays < 30) weight += 1.5;
    return { v, weight };
  }).sort((a, b) => b.weight - a.weight).map((x) => x.v);
}

/** Up-next queue for the watch page: same series first, then channel, then similar topics. */
export function relatedTo(video, limit = 24) {
  if (!video) return [];
  const out = [];
  const pushed = new Set([video.id]);
  const add = (v) => { if (v && !pushed.has(v.id)) { pushed.add(v.id); out.push(v); } };

  if (video.seriesId) {
    const eps = videosOfSeries(video.seriesId);
    const i = eps.findIndex((e) => e.id === video.id);
    eps.slice(i + 1).forEach(add);
    eps.slice(0, Math.max(0, i)).forEach(add);
  }
  videosOfChannel(video.channelId).forEach(add);

  const topics = new Set(video.topics || []);
  const sameTopic = store.catalog.videos
    .filter((v) => (v.topics || []).some((t) => topics.has(t)))
    .sort((a, b) => viewsOf(b) - viewsOf(a));
  sameTopic.forEach(add);

  seededShuffle(store.catalog.videos, video.id).forEach(add);
  return out.slice(0, limit);
}

/** The next episode in a series, or null at the end. */
export function nextEpisode(video) {
  if (!video?.seriesId) return null;
  const eps = videosOfSeries(video.seriesId);
  const i = eps.findIndex((e) => e.id === video.id);
  return i >= 0 ? eps[i + 1] || null : null;
}

/* ---------- viewer data ---------- */

function persistUser() {
  store.user.updatedAt = new Date().toISOString();
  lsSet(LS.user, store.user);
  events.emit('user');
  events.emit('dirty', 'user');
}

/** Replace the local viewer record (used when the repo copy is newer). */
export function adoptUser(remote) {
  if (!remote?.id) return;
  store.user = { ...blankUser(), ...remote };
  lsSet(LS.user, store.user);
  events.emit('user');
}

function bumpStat(kind, videoId, delta) {
  store.stats[kind][videoId] = (store.stats[kind][videoId] || 0) + delta;
  store.pendingStats[kind][videoId] = (store.pendingStats[kind][videoId] || 0) + delta;
  events.emit('dirty', 'stats');
}

export function clearPendingStats() {
  store.pendingStats = { views: {}, likes: {} };
}

export function persistSettings() {
  lsSet(LS.settings, store.settings);
  events.emit('settings');
}

export function setSetting(key, value) {
  store.settings[key] = value;
  persistSettings();
}

export function setProfile({ name, avatar }) {
  if (name !== undefined) store.user.name = String(name).slice(0, 40) || 'Guest';
  if (avatar !== undefined) store.user.avatar = avatar || null;
  persistUser();
}

export const isSubscribed = (channelId) => store.user.subscriptions.includes(channelId);

export function toggleSubscribe(channelId) {
  const subs = store.user.subscriptions;
  const i = subs.indexOf(channelId);
  if (i >= 0) subs.splice(i, 1);
  else subs.push(channelId);
  persistUser();
  return i < 0;
}

export const ratingOf = (videoId) => store.user.ratings[videoId] || 0;

/** Toggle like (1) / dislike (-1). Returns the new rating. */
export function rateVideo(videoId, rating) {
  const current = ratingOf(videoId);
  const next = current === rating ? 0 : rating;
  if (next === 0) delete store.user.ratings[videoId];
  else store.user.ratings[videoId] = next;

  // Keep the displayed aggregate honest about this viewer's own vote.
  const delta = (next === 1 ? 1 : 0) - (current === 1 ? 1 : 0);
  if (delta) bumpStat('likes', videoId, delta);
  persistUser();
  return next;
}

/* ---------- history & resume position ---------- */

const HISTORY_LIMIT = 500;
/** Below this, we treat playback as "not really started" and don't save a resume point. */
const RESUME_MIN_SECONDS = 10;
/** Within this much of the end, the video counts as finished and restarts from 0. */
const RESUME_TAIL_SECONDS = 15;

export const historyEntry = (videoId) =>
  store.user.history.find((h) => h.videoId === videoId) || null;

/** Seconds to resume from, or 0 to start at the beginning. */
export function resumePosition(videoId) {
  const entry = historyEntry(videoId);
  if (!entry || entry.completed) return 0;
  if (entry.position < RESUME_MIN_SECONDS) return 0;
  if (entry.duration && entry.position > entry.duration - RESUME_TAIL_SECONDS) return 0;
  return Math.floor(entry.position);
}

/** 0..1 progress for the bar on thumbnails. */
export function progressRatio(videoId) {
  const entry = historyEntry(videoId);
  if (!entry) return 0;
  if (entry.completed) return 1;
  const duration = entry.duration || getVideo(videoId)?.durationSec || 0;
  return duration ? Math.min(1, entry.position / duration) : 0;
}

export function recordProgress(videoId, position, duration) {
  if (!videoId || !Number.isFinite(position)) return;
  const list = store.user.history;
  const i = list.findIndex((h) => h.videoId === videoId);
  const completed = Boolean(duration) && position >= duration - RESUME_TAIL_SECONDS;
  const entry = {
    videoId,
    position: Math.max(0, Math.floor(position)),
    duration: Math.floor(duration || list[i]?.duration || 0),
    updatedAt: new Date().toISOString(),
    completed,
  };
  if (i >= 0) list.splice(i, 1);
  list.unshift(entry); // most recent first
  if (list.length > HISTORY_LIMIT) list.length = HISTORY_LIMIT;
  persistUser();
}

export function markViewed(videoId) {
  bumpStat('views', videoId, 1);
}

export function removeFromHistory(videoId) {
  store.user.history = store.user.history.filter((h) => h.videoId !== videoId);
  persistUser();
}

export function clearHistory() {
  store.user.history = [];
  persistUser();
}

/** Partly-watched videos, newest first — the "Continue watching" shelf. */
export function continueWatching(limit = 12) {
  return store.user.history
    .filter((h) => !h.completed && h.position >= RESUME_MIN_SECONDS && getVideo(h.videoId))
    .slice(0, limit)
    .map((h) => getVideo(h.videoId));
}

export function historyVideos() {
  return store.user.history.map((h) => getVideo(h.videoId)).filter(Boolean);
}

/** Newest uploads from subscribed channels. */
export function subscriptionFeed() {
  const subs = new Set(store.user.subscriptions);
  return store.catalog.videos
    .filter((v) => subs.has(v.channelId))
    .sort((a, b) => new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0));
}

export const likedVideos = () =>
  Object.entries(store.user.ratings)
    .filter(([, r]) => r === 1)
    .map(([id]) => getVideo(id))
    .filter(Boolean);

/* ---------- viewer playlists ---------- */

export function createPlaylist(title, { description = '', visibility = 'private', videoIds = [] } = {}) {
  const pl = {
    id: uid('pl'),
    title: String(title || 'New playlist').slice(0, 100),
    description,
    visibility,
    videoIds: [...videoIds],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  store.user.playlists.unshift(pl);
  persistUser();
  return pl;
}

export const userPlaylist = (id) => store.user.playlists.find((p) => p.id === id) || null;

export function updatePlaylist(id, patch) {
  const pl = userPlaylist(id);
  if (!pl) return null;
  Object.assign(pl, patch, { updatedAt: new Date().toISOString() });
  persistUser();
  return pl;
}

export function deletePlaylist(id) {
  store.user.playlists = store.user.playlists.filter((p) => p.id !== id);
  persistUser();
}

/** Add or remove a video. Returns true when the video ends up in the playlist. */
export function togglePlaylistVideo(playlistId, videoId) {
  const pl = userPlaylist(playlistId);
  if (!pl) return false;
  const i = pl.videoIds.indexOf(videoId);
  if (i >= 0) pl.videoIds.splice(i, 1);
  else pl.videoIds.push(videoId);
  pl.updatedAt = new Date().toISOString();
  persistUser();
  return i < 0;
}

export const inWatchLater = (videoId) => store.user.watchLater.includes(videoId);

export function toggleWatchLater(videoId) {
  const list = store.user.watchLater;
  const i = list.indexOf(videoId);
  if (i >= 0) list.splice(i, 1);
  else list.unshift(videoId);
  persistUser();
  return i < 0;
}

export const watchLaterVideos = () => store.user.watchLater.map(getVideo).filter(Boolean);
