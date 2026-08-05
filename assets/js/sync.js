// Background sync of viewer data.
//
// Signed out, this is entirely inert and everything lives in localStorage.
// Signed in, local changes are mirrored to the server on a debounce, and the
// server copy is pulled once at sign-in.
//
// The UI never awaits any of this — mutations are already in localStorage by
// the time sync runs.

import { api } from './api.js';
import { auth, authEvents, isSignedIn } from './auth.js';
import { store, events, adoptUser, clearPendingStats } from './store.js';

const DEBOUNCE_MS = 4000;

export const status = {
  state: 'off',   // 'off' | 'idle' | 'pending' | 'saving' | 'saved' | 'error'
  lastSyncedAt: null,
  error: null,
};

const dirty = new Set();
let timer = null;
let inFlight = null;

const enabled = () => isSignedIn() && store.settings.sync !== false;

function setState(state, error = null) {
  status.state = state;
  status.error = error;
  events.emit('sync', status);
}

/* ---------- pull ---------- */

/**
 * Merge the server's copy with whatever is on this device.
 *
 * Whichever side was written most recently wins outright. That keeps the rule
 * predictable — the alternative, field-by-field merging, makes an unsubscribe
 * on one device silently reappear from another.
 */
export async function pull({ preferLocal = false } = {}) {
  if (!enabled()) return false;
  try {
    const { data } = await api.getMe();
    if (!data) return false;

    const remoteAt = new Date(data.updatedAt || 0).getTime();
    const localAt = new Date(store.user.updatedAt || 0).getTime();

    if (preferLocal && localAt > 0) {
      // Just signed in on a device that already has local history — keep it and
      // push, so nothing the person did as a guest is thrown away.
      schedule('user');
      return false;
    }
    if (remoteAt > localAt) {
      adoptUser({ ...data, id: auth.user.id });
      return true;
    }
    if (localAt > remoteAt) schedule('user');
  } catch (err) {
    console.warn('[sync] pull failed:', err.message);
  }
  return false;
}

/* ---------- push ---------- */

async function pushUser() {
  const { id, name, avatar, subscriptions, history, ratings, playlists, watchLater } = store.user;
  await api.putMe({ id, name, avatar, subscriptions, history, ratings, playlists, watchLater });
}

async function pushStats() {
  const pending = takePending();
  if (!pending) return;
  try {
    await api.postStats(pending);
  } catch (err) {
    returnPending(pending);
    throw err;
  }
}

function takePending() {
  const { views, likes } = store.pendingStats;
  if (!Object.keys(views).length && !Object.keys(likes).length) return null;
  const snapshot = { views: { ...views }, likes: { ...likes } };
  clearPendingStats();
  return snapshot;
}

function returnPending(pending) {
  for (const kind of ['views', 'likes']) {
    for (const [id, delta] of Object.entries(pending[kind])) {
      store.pendingStats[kind][id] = (store.pendingStats[kind][id] || 0) + delta;
    }
  }
}

async function flushNow() {
  if (dirty.size === 0) return;

  // Counters are anonymous, so they still go up for signed-out viewers.
  const jobs = new Set(dirty);
  dirty.clear();
  if (!isSignedIn()) jobs.delete('user');
  if (!jobs.size) { setState(isSignedIn() ? 'idle' : 'off'); return; }

  if (inFlight) return inFlight;
  setState('saving');

  inFlight = (async () => {
    try {
      if (jobs.has('user') && enabled()) await pushUser();
      if (jobs.has('stats')) await pushStats();
      status.lastSyncedAt = new Date().toISOString();
      setState('saved');
    } catch (err) {
      for (const job of jobs) dirty.add(job);
      console.warn('[sync] push failed:', err.message);
      setState('error', err.message);
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

export function schedule(kind) {
  if (kind) dirty.add(kind);
  if (!isSignedIn() && !dirty.has('stats')) { setState('off'); return; }
  setState('pending');
  clearTimeout(timer);
  timer = setTimeout(flushNow, DEBOUNCE_MS);
}

export function flush() {
  clearTimeout(timer);
  return flushNow();
}

export function start() {
  events.on('dirty', schedule);

  authEvents.on('signin', async () => {
    setState('idle');
    await pull({ preferLocal: store.user.history.length > 0 });
  });
  authEvents.on('signout', () => {
    dirty.clear();
    clearTimeout(timer);
    setState('off');
  });

  const saveOnExit = () => { if (dirty.size) flush(); };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') saveOnExit();
  });
  window.addEventListener('pagehide', saveOnExit);

  setState(isSignedIn() ? 'idle' : 'off');
}
