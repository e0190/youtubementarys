// Step 2 of Google sign-in: swap the authorization code for tokens, then
// create (or reuse) an account and start a session.
//
// The code is exchanged server-to-server over TLS using the client secret, so
// the id_token in that response came from Google directly and its claims can be
// read without a separate signature check.

import { route, origin, query, HttpError } from '../../_lib/http.js';
import { parseCookies } from '../../_lib/auth.js';
import {
  findAccountByEmail, findAccountByProvider, createAccount, updateAccount,
  sessionFor, signToken, setSessionCookie, cleanName, normaliseEmail,
} from '../../_lib/auth.js';

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

function decodeIdToken(idToken) {
  const parts = String(idToken || '').split('.');
  if (parts.length !== 3) throw new HttpError(502, 'Google returned a malformed token.');
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    throw new HttpError(502, 'Google returned a token we could not read.');
  }
}

/** Send the browser back into the app with a message it can show. */
function bounce(res, req, hash) {
  res.statusCode = 302;
  res.setHeader('Location', `${origin(req)}/${hash}`);
  // The one-shot cookies have done their job.
  res.setHeader('Set-Cookie', [
    'ym_oauth_state=; Path=/api/auth/google; HttpOnly; SameSite=Lax; Secure; Max-Age=0',
    'ym_oauth_next=; Path=/api/auth/google; HttpOnly; SameSite=Lax; Secure; Max-Age=0',
    ...(Array.isArray(res.getHeader('Set-Cookie')) ? res.getHeader('Set-Cookie') : []),
  ]);
  res.end();
}

export default route(async (req, res) => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new HttpError(503, 'Google sign-in is not configured on this deployment.');
  }

  const params = query(req);
  const cookies = parseCookies(req);

  if (params.error) {
    // The person pressed Cancel, or Google refused. Not an error worth a 500.
    return bounce(res, req, '#/?auth=cancelled');
  }

  if (!params.code) throw new HttpError(400, 'Google did not return an authorization code.');
  if (!params.state || params.state !== cookies.ym_oauth_state) {
    throw new HttpError(400, 'Sign-in could not be verified. Please start again.');
  }

  const tokenRes = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code: params.code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: `${origin(req)}/api/auth/google/callback`,
      grant_type: 'authorization_code',
    }),
  });

  if (!tokenRes.ok) {
    let detail = tokenRes.statusText;
    try { detail = (await tokenRes.json()).error_description || detail; } catch { /* keep status */ }
    throw new HttpError(502, `Google rejected the sign-in: ${detail}`);
  }

  const claims = decodeIdToken((await tokenRes.json()).id_token);

  if (!claims.email) throw new HttpError(502, 'Google did not share an email address.');
  if (claims.email_verified === false) {
    throw new HttpError(403, 'That Google account has an unverified email address.');
  }
  if (claims.aud !== clientId) {
    throw new HttpError(502, 'Google returned a token for a different application.');
  }

  const email = normaliseEmail(claims.email);
  const name = cleanName(claims.name || claims.given_name, email.split('@')[0]);
  const avatar = typeof claims.picture === 'string' ? claims.picture : null;

  // Prefer an existing Google identity; otherwise adopt an account that already
  // owns this email so signing up by email then using Google doesn't fork into
  // two profiles.
  let account = await findAccountByProvider('google', claims.sub);
  if (!account) {
    const existing = await findAccountByEmail(email);
    account = existing
      ? await updateAccount(existing.id, {
          provider: existing.provider === 'password' ? existing.provider : 'google',
          providerId: claims.sub,
          avatar: existing.avatar || avatar,
        })
      : await createAccount({ email, name, avatar, provider: 'google', providerId: claims.sub });
  } else if (account.avatar !== avatar || account.name !== name) {
    account = await updateAccount(account.id, { name, avatar }) || account;
  }

  setSessionCookie(res, signToken(sessionFor(account)));
  bounce(res, req, `${decodeURIComponent(cookies.ym_oauth_next || '#/')}`);
});
