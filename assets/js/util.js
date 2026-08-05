// Small helpers shared across the app. No dependencies.

/* ---------- DOM ---------- */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/** Create an element. `attrs` supports class/dataset/style/on* handlers. */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

/** Escape a string for safe interpolation into an HTML template. */
export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/** Replace all children of `node` with `content`. */
export function render(node, content) {
  node.replaceChildren(...(Array.isArray(content) ? content.flat(Infinity).filter(Boolean) : [content]));
  return node;
}

/**
 * Replace a node's children, dropping conditional blanks.
 *
 * Native replaceChildren() stringifies anything that isn't a Node, so passing
 * `cond ? icon() : null` silently renders the text "null". Use this whenever
 * any child is conditional.
 */
export function setChildren(node, ...children) {
  node.replaceChildren(...children.flat(Infinity)
    .filter((c) => c !== null && c !== undefined && c !== false)
    .map((c) => (c instanceof Node ? c : document.createTextNode(String(c)))));
  return node;
}

/* ---------- formatting ---------- */

/** 1832000 -> "1.8M" */
export function compact(n) {
  n = Number(n) || 0;
  if (n < 1000) return String(n);
  const units = [[1e9, 'B'], [1e6, 'M'], [1e3, 'K']];
  for (const [size, suffix] of units) {
    if (n >= size) {
      const v = n / size;
      return (v >= 100 ? Math.round(v) : Math.round(v * 10) / 10) + suffix;
    }
  }
  return String(n);
}

/** 3120 -> "52:00", 3720 -> "1:02:00" */
export function timecode(seconds) {
  seconds = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const pad = (x) => String(x).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** 3120 -> "52 minutes", used for screen readers and metadata rows. */
export function durationWords(seconds) {
  const total = Math.round((Number(seconds) || 0) / 60);
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h && m) return `${h} hr ${m} min`;
  if (h) return `${h} hr`;
  return `${m} min`;
}

/**
 * Parse a catalog date.
 *
 * `new Date('1953-01-01')` is UTC midnight, which renders as 31 Dec 1952 for
 * anyone west of Greenwich. Date-only strings are calendar dates, not instants,
 * so build them in local time instead.
 */
export function parseDate(value) {
  if (value instanceof Date) return value;
  const s = String(value ?? '');
  const dateOnly = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateOnly) {
    return new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]));
  }
  return new Date(s);
}

/** ISO date -> "3 years ago" */
export function timeAgo(iso) {
  const then = parseDate(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const secs = Math.max(0, (Date.now() - then) / 1000);
  const steps = [
    [31536000, 'year'], [2592000, 'month'], [604800, 'week'],
    [86400, 'day'], [3600, 'hour'], [60, 'minute'],
  ];
  for (const [size, label] of steps) {
    if (secs >= size) {
      const v = Math.floor(secs / size);
      return `${v} ${label}${v === 1 ? '' : 's'} ago`;
    }
  }
  return 'just now';
}

export function longDate(iso) {
  const d = parseDate(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/* ---------- misc ---------- */

export const uid = (prefix = 'id') =>
  `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

export function slugify(s) {
  return String(s).toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

export function debounce(fn, ms = 200) {
  let t;
  const wrapped = (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
  wrapped.cancel = () => clearTimeout(t);
  return wrapped;
}

export function throttle(fn, ms = 200) {
  let last = 0, timer;
  return (...args) => {
    const now = Date.now();
    const remaining = ms - (now - last);
    if (remaining <= 0) {
      clearTimeout(timer);
      last = now;
      fn(...args);
    } else if (!timer) {
      timer = setTimeout(() => { last = Date.now(); timer = null; fn(...args); }, remaining);
    }
  };
}

export const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

/** Deterministic 0-359 hue from a string — used for generated avatars. */
export function hueFrom(str) {
  let h = 0;
  for (let i = 0; i < String(str).length; i++) h = (h * 31 + str.charCodeAt(i)) % 360;
  return h;
}

export function initials(name) {
  return String(name || '?')
    .split(/\s+/).filter(Boolean).slice(0, 2)
    .map((w) => w[0].toUpperCase()).join('');
}

/** Fisher-Yates shuffle seeded off a string, so "recommended" is stable per video. */
export function seededShuffle(arr, seed) {
  const out = arr.slice();
  let s = hueFrom(seed) + 1;
  const rand = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/* ---------- storage ---------- */

export function lsGet(key, fallback = null) {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function lsSet(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    // Quota exceeded or storage disabled (private mode). Not fatal — the app
    // keeps working in memory for the rest of the session.
    return false;
  }
}

export function lsRemove(key) {
  try { localStorage.removeItem(key); } catch { /* ignore */ }
}

/* ---------- base64 (UTF-8 safe, chunked for large payloads) ---------- */

export function b64encode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

export function b64decode(b64) {
  const bin = atob(String(b64).replace(/\s/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/* ---------- events ---------- */

export function emitter() {
  const map = new Map();
  return {
    on(evt, cb) {
      if (!map.has(evt)) map.set(evt, new Set());
      map.get(evt).add(cb);
      return () => map.get(evt)?.delete(cb);
    },
    off(evt, cb) { map.get(evt)?.delete(cb); },
    emit(evt, ...args) {
      for (const cb of map.get(evt) ?? []) {
        try { cb(...args); } catch (err) { console.error(`[${evt}]`, err); }
      }
    },
    clear() { map.clear(); },
  };
}

/** Extract a YouTube video id from a URL or return the input if it already is one. */
export function parseYouTubeId(input) {
  const s = String(input || '').trim();
  if (/^[\w-]{11}$/.test(s)) return s;
  const patterns = [
    /(?:youtube\.com\/watch\?[^#]*\bv=)([\w-]{11})/,
    /youtu\.be\/([\w-]{11})/,
    /youtube\.com\/embed\/([\w-]{11})/,
    /youtube\.com\/shorts\/([\w-]{11})/,
    /youtube\.com\/live\/([\w-]{11})/,
  ];
  for (const re of patterns) {
    const m = s.match(re);
    if (m) return m[1];
  }
  return null;
}
