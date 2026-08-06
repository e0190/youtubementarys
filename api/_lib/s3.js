// Presigned uploads for any S3-compatible bucket.
//
// The browser never sees the secret key. It asks /api/upload/sign for a URL
// that is valid for one PUT, of one object, for a few minutes — then uploads
// the file straight to the bucket. Nothing large passes through a serverless
// function, which matters because those cap request bodies at a few megabytes.
//
// Works with Cloudflare R2, Backblaze B2, AWS S3, Wasabi, MinIO — anything
// speaking SigV4. R2 is the one to reach for with video: no egress charges.

import { createHmac, createHash } from 'node:crypto';
import { HttpError } from './http.js';

export const config = {
  get endpoint() { return (process.env.S3_ENDPOINT || '').replace(/\/+$/, ''); },
  get bucket() { return process.env.S3_BUCKET || ''; },
  get region() { return process.env.S3_REGION || 'auto'; },
  get accessKeyId() { return process.env.S3_ACCESS_KEY_ID || ''; },
  get secretAccessKey() { return process.env.S3_SECRET_ACCESS_KEY || ''; },
  /** Where objects are served from, if that differs from the API endpoint. */
  get publicBase() { return (process.env.S3_PUBLIC_BASE_URL || '').replace(/\/+$/, ''); },
  get maxBytes() { return Number(process.env.UPLOAD_MAX_BYTES) || 2 * 1024 * 1024 * 1024; },
};

export function isConfigured() {
  return Boolean(config.endpoint && config.bucket && config.accessKeyId && config.secretAccessKey);
}

function requireConfig() {
  if (!isConfigured()) {
    throw new HttpError(503,
      'Uploads are not configured. Set S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID and '
      + 'S3_SECRET_ACCESS_KEY in the environment — or paste a link to a file you host elsewhere.');
  }
}

/* ---------- SigV4 ---------- */

const sha256hex = (data) => createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => createHmac('sha256', key).update(data).digest();

/** Percent-encode per RFC 3986, which is stricter than encodeURIComponent. */
function uriEncode(str, encodeSlash = true) {
  return String(str).replace(/[^A-Za-z0-9_.~\-/]/g, (c) =>
    `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`)
    .replace(/\//g, encodeSlash ? '%2F' : '/');
}

function signingKey(secret, dateStamp, region, service) {
  return hmac(hmac(hmac(hmac(`AWS4${secret}`, dateStamp), region), service), 'aws4_request');
}

/**
 * Build a presigned URL.
 *
 * Query-string signing (rather than header signing) is what lets a browser do a
 * plain fetch/XHR PUT with no custom auth headers — which in turn keeps the
 * request simple enough to avoid CORS preflight surprises.
 */
export function presign(key, {
  method = 'PUT',
  expiresIn = 900,
  contentType = null,
  extraHeaders = {},
} = {}) {
  requireConfig();

  const url = new URL(`${config.endpoint}/${config.bucket}/${key.split('/').map((p) => uriEncode(p)).join('/')}`);
  const host = url.host;

  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');   // 20260806T010203Z
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/${config.region}/s3/aws4_request`;

  // Content-Type must be signed when the client will send it, or the bucket
  // rejects the PUT with a signature mismatch.
  const headers = { host, ...(contentType ? { 'content-type': contentType } : {}), ...extraHeaders };
  const signedHeaders = Object.keys(headers).map((h) => h.toLowerCase()).sort();
  const canonicalHeaders = signedHeaders
    .map((h) => `${h}:${String(headers[Object.keys(headers).find((k) => k.toLowerCase() === h)]).trim()}\n`)
    .join('');

  const query = new URLSearchParams({
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${config.accessKeyId}/${scope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(Math.min(expiresIn, 604800)),
    'X-Amz-SignedHeaders': signedHeaders.join(';'),
  });

  // Canonical query strings must be sorted by key, with both sides encoded.
  const canonicalQuery = [...query.entries()]
    .map(([k, v]) => [uriEncode(k), uriEncode(v)])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');

  const canonicalRequest = [
    method,
    uriEncode(url.pathname, false),
    canonicalQuery,
    canonicalHeaders,
    signedHeaders.join(';'),
    'UNSIGNED-PAYLOAD',
  ].join('\n');

  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    sha256hex(canonicalRequest),
  ].join('\n');

  const signature = createHmac('sha256', signingKey(config.secretAccessKey, dateStamp, config.region, 's3'))
    .update(stringToSign)
    .digest('hex');

  return `${url.origin}${url.pathname}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

/** Public URL an uploaded object will be served from. */
export function publicUrl(key) {
  const encoded = key.split('/').map((p) => uriEncode(p)).join('/');
  if (config.publicBase) return `${config.publicBase}/${encoded}`;
  return `${config.endpoint}/${config.bucket}/${encoded}`;
}

/* ---------- object keys ---------- */

const EXTENSIONS = {
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/ogg': 'ogv',
  'video/quicktime': 'mov',
  'video/x-matroska': 'mkv',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

export const ALLOWED_VIDEO_TYPES = ['video/mp4', 'video/webm', 'video/ogg', 'video/quicktime', 'video/x-matroska'];
export const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

/**
 * Namespaced, collision-proof object key.
 *
 * Everything a person uploads sits under their own user id, so one account can
 * never overwrite another's file by guessing a name.
 */
export function objectKey({ userId, kind, filename, contentType }) {
  const stamp = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  const ext = EXTENSIONS[contentType]
    || String(filename || '').split('.').pop()?.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 5)
    || 'bin';
  const safeUser = String(userId).replace(/[^\w-]/g, '').slice(0, 40);
  return `${kind}/${safeUser}/${stamp}${rand}.${ext}`;
}
