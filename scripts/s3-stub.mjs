// A tiny S3-compatible endpoint for local development.
//
// It accepts presigned PUTs, verifies the SigV4 signature the way a real bucket
// would, stores objects on disk and serves them back with CORS and range
// support. That last part matters: without ranges the video player can't seek.
//
//   node scripts/s3-stub.mjs [--port 9000]
//
// Not part of the deployed site.

import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHmac, createHash } from 'node:crypto';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const STORE = join(ROOT, '.dev-storage', 'bucket');

const argPort = process.argv.indexOf('--port');
const PORT = Number(argPort > -1 ? process.argv[argPort + 1] : 0) || 9000;

const ACCESS_KEY = process.env.S3_ACCESS_KEY_ID || 'devkey';
const SECRET_KEY = process.env.S3_SECRET_ACCESS_KEY || 'devsecret';
const REGION = process.env.S3_REGION || 'auto';

const hmac = (key, data) => createHmac('sha256', key).update(data).digest();
const sha256hex = (data) => createHash('sha256').update(data).digest('hex');

function uriEncode(str, encodeSlash = true) {
  return String(str).replace(/[^A-Za-z0-9_.~\-/]/g, (c) =>
    `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`)
    .replace(/\//g, encodeSlash ? '%2F' : '/');
}

/** Recompute the signature and compare — the same check a real bucket makes. */
function verify(req, url) {
  const params = url.searchParams;
  const provided = params.get('X-Amz-Signature');
  if (!provided) return 'Missing X-Amz-Signature';

  const credential = params.get('X-Amz-Credential') || '';
  const [keyId, dateStamp, region, service] = credential.split('/');
  if (keyId !== ACCESS_KEY) return `Unknown access key ${keyId}`;

  const amzDate = params.get('X-Amz-Date');
  const expires = Number(params.get('X-Amz-Expires') || 0);
  const signedHeaders = (params.get('X-Amz-SignedHeaders') || '').split(';');

  // Expiry check, using the timestamp format SigV4 puts on the wire.
  const iso = `${amzDate.slice(0, 4)}-${amzDate.slice(4, 6)}-${amzDate.slice(6, 8)}T`
    + `${amzDate.slice(9, 11)}:${amzDate.slice(11, 13)}:${amzDate.slice(13, 15)}Z`;
  const age = (Date.now() - Date.parse(iso)) / 1000;
  if (Number.isFinite(age) && age > expires) return 'Request has expired';

  const canonicalHeaders = signedHeaders
    .map((h) => `${h}:${String(req.headers[h] || '').trim()}\n`)
    .join('');

  const canonicalQuery = [...params.entries()]
    .filter(([k]) => k !== 'X-Amz-Signature')
    .map(([k, v]) => [uriEncode(k), uriEncode(v)])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');

  const canonicalRequest = [
    req.method,
    uriEncode(url.pathname, false),
    canonicalQuery,
    canonicalHeaders,
    signedHeaders.join(';'),
    'UNSIGNED-PAYLOAD',
  ].join('\n');

  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest)].join('\n');
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${SECRET_KEY}`, dateStamp), region), service), 'aws4_request');
  const expected = createHmac('sha256', signingKey).update(stringToSign).digest('hex');

  return provided === expected ? null : 'SignatureDoesNotMatch';
}

const cors = (res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Expose-Headers', 'ETag, Content-Length, Content-Range, Accept-Ranges');
};

const fail = (res, code, message) => {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/xml');
  res.end(`<?xml version="1.0"?><Error><Code>${code}</Code><Message>${message}</Message></Error>`);
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  cors(res);

  if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }

  const key = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
  if (!key) return fail(res, 400, 'No object key');
  if (key.includes('..')) return fail(res, 400, 'Bad key');

  const file = join(STORE, key);

  if (req.method === 'PUT') {
    const problem = verify(req, url);
    if (problem) {
      console.log(`\x1b[31m403\x1b[0m PUT ${key} — ${problem}`);
      return fail(res, 403, problem);
    }

    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);

    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, body);
    await writeFile(`${file}.type`, req.headers['content-type'] || 'application/octet-stream');

    res.statusCode = 200;
    res.setHeader('ETag', `"${createHash('md5').update(body).digest('hex')}"`);
    res.end();
    console.log(`\x1b[32m200\x1b[0m PUT ${key} (${body.length} bytes)`);
    return;
  }

  if (req.method === 'GET' || req.method === 'HEAD') {
    if (!existsSync(file)) return fail(res, 404, 'NoSuchKey');
    const info = await stat(file);
    const type = existsSync(`${file}.type`)
      ? await readFile(`${file}.type`, 'utf8')
      : 'application/octet-stream';

    res.setHeader('Content-Type', type);
    res.setHeader('Accept-Ranges', 'bytes');

    // Range support — the player needs it to seek.
    const range = req.headers.range;
    if (range) {
      const [, startStr, endStr] = /bytes=(\d*)-(\d*)/.exec(range) || [];
      const start = startStr ? Number(startStr) : 0;
      const end = endStr ? Number(endStr) : info.size - 1;
      res.statusCode = 206;
      res.setHeader('Content-Range', `bytes ${start}-${end}/${info.size}`);
      res.setHeader('Content-Length', end - start + 1);
      if (req.method === 'HEAD') { res.end(); return; }
      createReadStream(file, { start, end }).pipe(res);
      return;
    }

    res.statusCode = 200;
    res.setHeader('Content-Length', info.size);
    if (req.method === 'HEAD') { res.end(); return; }
    createReadStream(file).pipe(res);
    return;
  }

  fail(res, 405, 'Method not allowed');
});

server.listen(PORT, () => {
  console.log(`\n  S3 stub on http://localhost:${PORT}`);
  console.log(`  objects: ${STORE}`);
  console.log(`  key: ${ACCESS_KEY} / region: ${REGION}\n`);
});
