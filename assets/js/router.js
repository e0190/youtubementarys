// Hash router.
//
// Hash routing (rather than the History API) means deep links like
// #/watch?v=abc work on GitHub Pages with no server rewrite rules, and a hard
// refresh on any URL always serves index.html.

import { emitter } from './util.js';

export const routerEvents = emitter();

const routes = [];
let current = null;
let notFound = null;

/**
 * Register a route.
 * `pattern` uses :params — e.g. '/channel/:handle'. '*' matches anything.
 */
export function route(pattern, handler) {
  if (pattern === '*') { notFound = handler; return; }
  const keys = [];
  const regex = new RegExp('^' + pattern
    .replace(/\/+$/, '')
    .replace(/:(\w+)/g, (_, key) => { keys.push(key); return '([^/]+)'; })
    + '/?$');
  routes.push({ regex, keys, handler, pattern });
}

/** Split '#/watch?v=abc&t=90' into { path: '/watch', query: {v, t} }. */
export function parseHash(hash = location.hash) {
  const raw = String(hash).replace(/^#/, '') || '/';
  const [pathPart, queryPart = ''] = raw.split('?');
  const path = ('/' + pathPart.replace(/^\/+/, '')).replace(/\/+$/, '') || '/';
  const query = {};
  for (const [k, v] of new URLSearchParams(queryPart)) query[k] = v;
  return { path, query, raw };
}

/** Build a hash URL: href('/watch', {v: 'abc'}) -> '#/watch?v=abc' */
export function href(path, query = {}) {
  const params = new URLSearchParams(
    Object.entries(query).filter(([, v]) => v !== null && v !== undefined && v !== ''));
  const qs = params.toString();
  return `#${path}${qs ? `?${qs}` : ''}`;
}

export function navigate(path, query = {}, { replace = false } = {}) {
  const target = href(path, query);
  if (location.hash === target) { resolve(); return; }
  if (replace) history.replaceState(null, '', target);
  else location.hash = target;
}

export const currentRoute = () => current;

/** Scroll positions per route, so Back returns you where you were. */
const scrollMemory = new Map();

export function resolve() {
  const { path, query, raw } = parseHash();
  if (current) scrollMemory.set(current.raw, window.scrollY);

  for (const r of routes) {
    const match = path.match(r.regex);
    if (!match) continue;
    const params = {};
    r.keys.forEach((key, i) => { params[key] = decodeURIComponent(match[i + 1]); });
    current = { path, query, params, raw, pattern: r.pattern };
    routerEvents.emit('before', current);
    r.handler({ params, query, path });
    routerEvents.emit('after', current);
    restoreScroll(raw);
    return;
  }

  current = { path, query, params: {}, raw, pattern: '*' };
  routerEvents.emit('before', current);
  notFound?.({ params: {}, query, path });
  routerEvents.emit('after', current);
  restoreScroll(raw);
}

function restoreScroll(raw) {
  // Wait a frame so the new view has laid out before we jump.
  requestAnimationFrame(() => {
    window.scrollTo({ top: scrollMemory.get(raw) ?? 0, behavior: 'instant' });
  });
}

export function start() {
  window.addEventListener('hashchange', resolve);
  if (!location.hash) history.replaceState(null, '', '#/');
  resolve();
}
