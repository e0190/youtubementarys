import { route, json } from '../_lib/http.js';
import { clearSessionCookie } from '../_lib/auth.js';

export default route(async (req, res) => {
  clearSessionCookie(res);
  json(res, 200, { ok: true });
}, { methods: ['POST'] });
