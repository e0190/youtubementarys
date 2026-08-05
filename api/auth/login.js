import { route, json, readJsonBody, unauthorized, tooMany } from '../_lib/http.js';
import {
  normaliseEmail, findAccountByEmail, verifyPassword, publicProfile, sessionFor,
  signToken, setSessionCookie, throttleKey, noteAttempt, clearAttempts,
} from '../_lib/auth.js';

export default route(async (req, res) => {
  const key = throttleKey(req, 'login');
  const gate = noteAttempt(key, { limit: 10, windowMs: 15 * 60 * 1000 });
  if (!gate.ok) throw tooMany();

  const body = await readJsonBody(req);
  const email = normaliseEmail(body.email);
  const password = String(body.password ?? '');

  const account = await findAccountByEmail(email);

  // Same message and roughly the same work either way, so the response doesn't
  // reveal whether an address is registered.
  const ok = account?.passwordHash ? await verifyPassword(password, account.passwordHash) : false;
  if (!ok) {
    if (account && !account.passwordHash) {
      throw unauthorized(`That account signs in with ${account.provider === 'google' ? 'Google' : account.provider}. Use that button instead.`);
    }
    throw unauthorized('That email and password don’t match.');
  }

  clearAttempts(key);
  setSessionCookie(res, signToken(sessionFor(account)));
  json(res, 200, { user: publicProfile(account) });
}, { methods: ['POST'] });
