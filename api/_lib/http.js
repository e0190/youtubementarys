// Request/response helpers shared by every route.
//
// Vercel invokes handlers with Node's (req, res). These wrappers keep the route
// files down to their actual logic.

export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.details = details;
  }
}

export const badRequest = (msg, details) => new HttpError(400, msg, details);
export const unauthorized = (msg = 'Sign in to do that.') => new HttpError(401, msg);
export const forbidden = (msg = 'You don’t have access to that.') => new HttpError(403, msg);
export const notFound = (msg = 'Not found.') => new HttpError(404, msg);
export const conflict = (msg) => new HttpError(409, msg);
export const tooMany = (msg = 'Too many attempts. Try again shortly.') => new HttpError(429, msg);

export function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.end(JSON.stringify(body));
}

/** Read and parse a JSON body, with a size cap. */
export async function readJsonBody(req, { limit = 512 * 1024 } = {}) {
  // Some runtimes pre-parse the body; honour that when present.
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'object') return req.body;
    if (typeof req.body === 'string') {
      try { return req.body ? JSON.parse(req.body) : {}; } catch { throw badRequest('Body is not valid JSON.'); }
    }
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw badRequest('Request body is too large.');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw badRequest('Body is not valid JSON.');
  }
}

/** Parsed query string, independent of how the platform populated req.query. */
export function query(req) {
  if (req.query && typeof req.query === 'object') return req.query;
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  return Object.fromEntries(url.searchParams);
}

/**
 * Wrap a handler so thrown HttpErrors become clean JSON and anything else
 * becomes a 500 without leaking internals to the client.
 *
 * `methods` restricts which verbs reach the handler.
 */
export function route(handler, { methods = ['GET'] } = {}) {
  const allowed = methods.map((m) => m.toUpperCase());
  return async (req, res) => {
    try {
      if (!allowed.includes(req.method)) {
        res.setHeader('Allow', allowed.join(', '));
        throw new HttpError(405, `${req.method} is not allowed here.`);
      }
      await handler(req, res);
    } catch (err) {
      if (err instanceof HttpError) {
        json(res, err.status, { error: err.message, ...(err.details ? { details: err.details } : {}) });
        return;
      }
      console.error('[api]', req.method, req.url, err);
      json(res, 500, { error: 'Something went wrong on our end.' });
    }
  };
}

/**
 * Absolute origin of the current request.
 *
 * Vercel always sets x-forwarded-proto. Falling back to the socket rather than
 * assuming https matters for Google sign-in: the redirect_uri has to match the
 * scheme the browser actually used, or the OAuth exchange is rejected.
 */
export function origin(req) {
  const forwarded = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const proto = forwarded || (req.socket?.encrypted ? 'https' : 'http');
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}
