// Metadata for specific YouTube ids.
//
// Backs the "paste a URL" path in Studio — the form auto-fills title, duration,
// description and thumbnail instead of making someone type them.

import { route, json, query, badRequest } from '../_lib/http.js';
import { requireAdmin } from '../_lib/auth.js';
import { hydrateVideos } from './_client.js';

export default route(async (req, res) => {
  requireAdmin(req);

  const raw = String(query(req).ids || '').trim();
  if (!raw) throw badRequest('No video ids supplied.');

  const ids = raw.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 50);
  const videos = await hydrateVideos(ids);

  json(res, 200, { videos });
});
