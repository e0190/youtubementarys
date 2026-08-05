// Sessions, password hashing and account records.
//
// Zero dependencies — everything here is built on node:crypto, so the project
// deploys to Vercel with no install step.
//
// A session is a signed, self-contained token in an httpOnly cookie. There is no
// server-side session table to keep in sync, which suits a stateless runtime;
// the trade-off is that revoking a single session before it expires isn't
// possible. Rotating AUTH_SECRET invalidates every session at once.

import {
  createHmac, randomBytes, scrypt as _scrypt, timingSafeEqual, randomUUID,
} from 'node:crypto';
import { promisify } from 'node:util';
import { readJSON, updateJSON } from './github.js';
import { HttpError, badRequest, unauthorized, conflict } from './http.js';

const scrypt = promisify(_scrypt);

const COOKIE = 'ym_session';
const SESSION_DAYS = 30;
const USERS_INDEX = 'data/auth/accounts.json';

/* ---------- secret ---------- */

function secret() {
  const value = process.env.AUTH_SECRET;
  if (!value || value.length < 16) {
    throw new HttpError(503,
      'Auth is not configured. Set AUTH_SECRET to a long random string in the environment.');
  }
  return value;
}

export const authConfigured = () => Boolean(process.env.AUTH_SECRET);

/* ---------- base64url ---------- */

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const unb64u = (str) => Buffer.from(str, 'base64url');

/* ---------- token sign / verify ---------- */

export function signToken(payload, { days = SESSION_DAYS } = {}) {
  const body = {
    ...payload,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + days * 86400,
  };
  const data = b64u(JSON.stringify(body));
  const sig = createHmac('sha256', secret()).update(data).digest('base64url');
  return `${data}.${sig}`;
}

export function verifyToken(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [data, sig] = token.split('.');
  if (!data || !sig) return null;

  const expected = createHmac('sha256', secret()).update(data).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  let payload;
  try {
    payload = JSON.parse(unb64u(data).toString('utf8'));
  } catch {
    return null;
  }
  if (!payload.exp || payload.exp * 1000 < Date.now()) return null;
  return payload;
}

/* ---------- cookies ---------- */

export function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** Append a cookie without dropping ones already queued on this response. */
export function appendCookie(res, value) {
  const existing = res.getHeader('Set-Cookie');
  const list = existing ? (Array.isArray(existing) ? existing : [existing]) : [];
  res.setHeader('Set-Cookie', [...list, value]);
}

/**
 * Secure cookies are never sent over plain http, which would make the whole
 * auth flow untestable on http://localhost. The local dev server sets
 * YM_INSECURE_COOKIES; every real deployment leaves it unset and gets Secure.
 */
const secureFlag = () => (process.env.YM_INSECURE_COOKIES === '1' ? [] : ['Secure']);

export function cookieAttrs({ path = '/', maxAge } = {}) {
  return [
    `Path=${path}`,
    'HttpOnly',
    // `Lax` rather than `Strict` so returning from Google's redirect still
    // carries the cookie.
    'SameSite=Lax',
    ...secureFlag(),
    `Max-Age=${maxAge}`,
  ].join('; ');
}

export function setSessionCookie(res, token, { days = SESSION_DAYS } = {}) {
  appendCookie(res, `${COOKIE}=${encodeURIComponent(token)}; ${cookieAttrs({ maxAge: days * 86400 })}`);
}

export function clearSessionCookie(res) {
  appendCookie(res, `${COOKIE}=; ${cookieAttrs({ maxAge: 0 })}`);
}

/** Session payload for this request, or null when signed out. */
export function currentSession(req) {
  if (!authConfigured()) return null;
  const token = parseCookies(req)[COOKIE];
  return token ? verifyToken(token) : null;
}

export function requireSession(req) {
  const session = currentSession(req);
  if (!session) throw unauthorized();
  return session;
}

/* ---------- admin ---------- */

export function isAdmin(session) {
  if (!session?.email) return false;
  const list = String(process.env.ADMIN_EMAILS || '')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  // With no list configured nobody is an admin — safer than defaulting to open.
  return list.includes(String(session.email).toLowerCase());
}

export function requireAdmin(req) {
  const session = requireSession(req);
  if (!isAdmin(session)) {
    throw new HttpError(403, 'Only administrators can change the catalog.');
  }
  return session;
}

/* ---------- passwords ---------- */

const SCRYPT_KEYLEN = 64;

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, SCRYPT_KEYLEN);
  return `scrypt$${salt.toString('base64url')}$${derived.toString('base64url')}`;
}

export async function verifyPassword(password, stored) {
  if (typeof stored !== 'string' || !stored.startsWith('scrypt$')) return false;
  const [, saltPart, hashPart] = stored.split('$');
  if (!saltPart || !hashPart) return false;
  const derived = await scrypt(password, unb64u(saltPart), SCRYPT_KEYLEN);
  const expected = unb64u(hashPart);
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}

/* ---------- validation ---------- */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function normaliseEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 200) {
    throw badRequest('Enter a valid email address.');
  }
  return email;
}

export function validatePassword(value) {
  const password = String(value ?? '');
  if (password.length < 8) throw badRequest('Use a password of at least 8 characters.');
  if (password.length > 200) throw badRequest('That password is too long.');
  return password;
}

export function cleanName(value, fallback = 'Viewer') {
  const name = String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, 40);
  return name || fallback;
}

/* ---------- account records ---------- */
//
// data/auth/accounts.json holds one entry per account. Password hashes live
// here; nothing in this file is ever sent to a browser.

const emptyIndex = () => ({ accounts: [] });

export async function findAccountByEmail(email) {
  const { data } = await readJSON(USERS_INDEX);
  const accounts = data?.accounts || [];
  return accounts.find((a) => a.email === email) || null;
}

export async function findAccountByProvider(provider, providerId) {
  const { data } = await readJSON(USERS_INDEX);
  const accounts = data?.accounts || [];
  return accounts.find((a) => a.provider === provider && a.providerId === providerId) || null;
}

/**
 * Create an account. `patch` supplies either passwordHash (email sign-up) or
 * provider/providerId (OAuth).
 */
export async function createAccount({ email, name, avatar = null, passwordHash = null, provider = 'password', providerId = null }) {
  const id = `u_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
  const record = {
    id,
    email,
    name,
    avatar,
    provider,
    providerId,
    ...(passwordHash ? { passwordHash } : {}),
    createdAt: new Date().toISOString(),
  };

  await updateJSON(USERS_INDEX, (data) => {
    const accounts = data?.accounts || [];
    // Re-check inside the transaction: two sign-ups can race between the
    // earlier lookup and this write.
    if (accounts.some((a) => a.email === email)) {
      throw conflict('An account with that email already exists.');
    }
    return { accounts: [...accounts, record] };
  }, {
    message: `auth: create account ${email}`,
    fallback: emptyIndex(),
  });

  return record;
}

/** Attach an OAuth identity to an existing account, or update its profile. */
export async function updateAccount(id, patch) {
  let updated = null;
  await updateJSON(USERS_INDEX, (data) => {
    const accounts = data?.accounts || [];
    const i = accounts.findIndex((a) => a.id === id);
    if (i < 0) return undefined; // nothing to do
    const next = accounts.slice();
    next[i] = { ...next[i], ...patch, updatedAt: new Date().toISOString() };
    updated = next[i];
    return { accounts: next };
  }, { message: `auth: update account ${id}`, fallback: emptyIndex() });
  return updated;
}

/** The shape the browser is allowed to see. */
export function publicProfile(account) {
  return {
    id: account.id,
    email: account.email,
    name: account.name,
    avatar: account.avatar || null,
    provider: account.provider,
    isAdmin: isAdmin(account),
  };
}

export function sessionFor(account) {
  return { sub: account.id, email: account.email, name: account.name };
}

/* ---------- brute-force damping ---------- */
//
// Best-effort only: serverless instances don't share memory, so this slows a
// naive attacker without pretending to be a real distributed rate limiter.

const attempts = new Map();

export function throttleKey(req, key) {
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  return `${key}:${ip}`;
}

export function noteAttempt(key, { limit = 10, windowMs = 15 * 60 * 1000 } = {}) {
  const now = Date.now();
  const entry = attempts.get(key);
  if (!entry || now - entry.start > windowMs) {
    attempts.set(key, { count: 1, start: now });
    return { ok: true, remaining: limit - 1 };
  }
  entry.count += 1;
  if (attempts.size > 5000) attempts.clear(); // crude ceiling on memory
  return { ok: entry.count <= limit, remaining: Math.max(0, limit - entry.count) };
}

export function clearAttempts(key) {
  attempts.delete(key);
}
