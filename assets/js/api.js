// Browser-side API client.
//
// Everything that used to hit GitHub directly now goes through our own /api
// routes. No credentials of any kind live in this file or anywhere else the
// browser can reach — the session is an httpOnly cookie the browser attaches
// automatically and JavaScript cannot read.

export class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

async function request(path, { method = 'GET', body, signal, timeout = 20000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  signal?.addEventListener('abort', () => controller.abort(), { once: true });

  let res;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') throw new ApiError('That took too long. Check your connection.', 0);
    throw new ApiError('Could not reach the server.', 0);
  }
  clearTimeout(timer);

  const isJson = (res.headers.get('content-type') || '').includes('application/json');
  const payload = isJson ? await res.json().catch(() => null) : null;

  if (!res.ok) {
    throw new ApiError(payload?.error || `Request failed (${res.status}).`, res.status, payload);
  }
  return payload;
}

export const api = {
  /* session */
  session: () => request('/api/auth/session'),
  register: (email, password, name) => request('/api/auth/register', { method: 'POST', body: { email, password, name } }),
  login: (email, password) => request('/api/auth/login', { method: 'POST', body: { email, password } }),
  logout: () => request('/api/auth/logout', { method: 'POST' }),
  googleSignInUrl: (next = location.hash || '#/') => `/api/auth/google/start?next=${encodeURIComponent(next)}`,

  /* viewer data */
  getMe: () => request('/api/me'),
  putMe: (data) => request('/api/me', { method: 'PUT', body: data }),

  /* catalog */
  getCollection: (name) => request(`/api/catalog/${name}`),
  saveItem: (name, item) => request(`/api/catalog/${name}`, { method: 'POST', body: item }),
  deleteItem: (name, id) => request(`/api/catalog/${name}`, { method: 'DELETE', body: { id } }),

  /* stats */
  getStats: () => request('/api/stats'),
  postStats: (deltas) => request('/api/stats', { method: 'POST', body: deltas }),

  /* comments */
  getComments: (videoId) => request(`/api/comments/${encodeURIComponent(videoId)}`),
  postComment: (videoId, text) => request(`/api/comments/${encodeURIComponent(videoId)}`, { method: 'POST', body: { text } }),
  deleteComment: (videoId, id) => request(`/api/comments/${encodeURIComponent(videoId)}`, { method: 'DELETE', body: { id } }),

  /* uploads */
  signUpload: (info) => request('/api/upload/sign', { method: 'POST', body: info }),
};

/**
 * The catalog is read straight from the static data/ files rather than through
 * the API: they are already on the CDN, so this avoids a function invocation on
 * every page load. Writes still go through /api/catalog.
 */
export async function fetchStaticJSON(path, { fresh = false } = {}) {
  const res = await fetch(`${path}${fresh ? `?t=${Date.now()}` : ''}`, {
    cache: fresh ? 'no-store' : 'default',
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new ApiError(`Could not load ${path} (${res.status}).`, res.status);
  return res.json();
}
