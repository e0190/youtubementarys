// Step 1 of Google sign-in: bounce the browser to Google's consent screen.
//
// A random `state` value is stored in a short-lived cookie and checked on the
// way back, so a third party can't feed us someone else's authorization code.

import { randomBytes } from 'node:crypto';
import { route, origin, HttpError, query } from '../../_lib/http.js';

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';

export const redirectUri = (req) => `${origin(req)}/api/auth/google/callback`;

export default route(async (req, res) => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId || !process.env.GOOGLE_CLIENT_SECRET) {
    throw new HttpError(503, 'Google sign-in is not configured on this deployment.');
  }

  const state = randomBytes(24).toString('base64url');
  // Where to land afterwards. Only same-site hash routes are accepted, so this
  // can't be turned into an open redirect.
  const requested = String(query(req).next || '');
  const next = /^#?\/[\w\-/?=&.%]*$/.test(requested) ? requested.replace(/^#?/, '#') : '#/';

  res.setHeader('Set-Cookie', [
    `ym_oauth_state=${state}; Path=/api/auth/google; HttpOnly; SameSite=Lax; Secure; Max-Age=600`,
    `ym_oauth_next=${encodeURIComponent(next)}; Path=/api/auth/google; HttpOnly; SameSite=Lax; Secure; Max-Age=600`,
  ]);

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri(req),
    response_type: 'code',
    scope: 'openid email profile',
    state,
    prompt: 'select_account',
  });

  res.statusCode = 302;
  res.setHeader('Location', `${AUTH_ENDPOINT}?${params}`);
  res.end();
});
