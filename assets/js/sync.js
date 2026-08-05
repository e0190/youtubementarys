// Background sync of viewer data to the repo.
//
// The UI never awaits this. Mutations are already in localStorage by the time
// sync runs; this just mirrors them to data/users/<id>.json and folds view/like
// counters into data/stats.json. If there's no token, or sync is switched off,
// every function here is a no-op and the app stays purely local.

import { PATHS } from './config.js';
import { hasToken, writeJSON, updateJSON, readJSON } from './github.js';
import {
  store, events, adoptUser, mergePendingStats, clearPendingStats,
} from './store.js';

const DEBOUNCE_MS = 6000;

export const status = {
  state: 'idle',   // 'idle' | 'pending' | 'saving' | 'saved' | 'error' | 'off'
  lastSyncedAt: null,
  error: null,
};

const dirty = new Set();
let timer = null;
let inFlight = null;

const enabled = () => Boolean(store.settings.sync && hasToken());

function setState(state, error = null) {
  status.state = state;
  status.error = error;
  events.emit('sync', status);
}

/** Pull the repo copy of the viewer record if it's newer than what's on this device. */
export async function pullUser() {
  if (!enabled()) return false;
  try {
    const { data } = await readJSON(PATHS.user(store.user.id), { fresh: true });
    if (!data?.id) return false;
    const remoteAt = new Date(data.updatedAt || 0).getTime();
    const localAt = new Date(store.user.updatedAt || 0).getTime();
    if (remoteAt > localAt) {
      adoptUser(data);
      return true;
    }
  } catch (err) {
    console.warn('[sync] pull failed:', err.message);
  }
  return false;
}

async function pushUser() {
  await writeJSON(PATHS.user(store.user.id), store.user, {
    message: `sync: ${store.user.name} (${store.user.id})`,
  });
}

async function pushStats() {
  const pending = store.pendingStats;
  const hasWork = Object.keys(pending.views).length || Object.keys(pending.likes).length;
  if (!hasWork) return;

  // Snapshot before the network call so counts recorded mid-flight aren't lost.
  const snapshot = mergePendingStats.bind(null);
  clearPendingStats();
  try {
    await updateJSON('data/stats.json', (remote) => snapshotApply(remote, pending), {
      message: 'sync: view and like counts',
      fallback: { views: {}, likes: {} },
    });
  } catch (err) {
    // Put the deltas back so the next run retries them.
    for (const kind of ['views', 'likes']) {
      for (const [id, delta] of Object.entries(pending[kind])) {
        store.pendingStats[kind][id] = (store.pendingStats[kind][id] || 0) + delta;
      }
    }
    void snapshot;
    throw err;
  }
}

function snapshotApply(remote, deltas) {
  const out = { views: {}, likes: {}, ...(remote || {}) };
  for (const kind of ['views', 'likes']) {
    out[kind] = { ...out[kind] };
    for (const [id, delta] of Object.entries(deltas[kind])) {
      out[kind][id] = Math.max(0, (out[kind][id] || 0) + delta);
    }
  }
  return out;
}

async function flushNow() {
  if (!enabled() || dirty.size === 0) return;
  if (inFlight) return inFlight;

  const jobs = new Set(dirty);
  dirty.clear();
  setState('saving');

  inFlight = (async () => {
    try {
      if (jobs.has('user')) await pushUser();
      if (jobs.has('stats')) await pushStats();
      status.lastSyncedAt = new Date().toISOString();
      setState('saved');
    } catch (err) {
      for (const job of jobs) dirty.add(job); // retry on the next tick
      console.warn('[sync] push failed:', err.message);
      setState('error', err.message);
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

/** Queue a flush. Called for you via the store's `dirty` event. */
export function schedule(kind) {
  if (kind) dirty.add(kind);
  if (!enabled()) { setState('off'); return; }
  setState('pending');
  clearTimeout(timer);
  timer = setTimeout(flushNow, DEBOUNCE_MS);
}

/** Force an immediate write — used when leaving the page. */
export function flush() {
  clearTimeout(timer);
  return flushNow();
}

export function start() {
  events.on('dirty', schedule);

  // Best-effort save when the tab is hidden or closed. `visibilitychange` is the
  // reliable one on mobile; `pagehide` covers desktop tab close.
  const saveOnExit = () => { if (dirty.size) flush(); };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') saveOnExit();
  });
  window.addEventListener('pagehide', saveOnExit);

  setState(enabled() ? 'idle' : 'off');
  if (enabled()) pullUser();
}
