import { route, json, readJsonBody, conflict, tooMany } from '../_lib/http.js';
import {
  normaliseEmail, validatePassword, cleanName, hashPassword, findAccountByEmail,
  createAccount, publicProfile, sessionFor, signToken, setSessionCookie,
  throttleKey, noteAttempt,
} from '../_lib/auth.js';

export default route(async (req, res) => {
  const gate = noteAttempt(throttleKey(req, 'register'), { limit: 5, windowMs: 60 * 60 * 1000 });
  if (!gate.ok) throw tooMany('Too many sign-up attempts. Try again later.');

  const body = await readJsonBody(req);
  const email = normaliseEmail(body.email);
  const password = validatePassword(body.password);
  const name = cleanName(body.name, email.split('@')[0]);

  if (await findAccountByEmail(email)) {
    throw conflict('An account with that email already exists. Try signing in.');
  }

  const account = await createAccount({
    email,
    name,
    passwordHash: await hashPassword(password),
    provider: 'password',
  });

  setSessionCookie(res, signToken(sessionFor(account)));
  json(res, 201, { user: publicProfile(account) });
}, { methods: ['POST'] });
