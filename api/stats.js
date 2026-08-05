// Aggregate play and like counters.
//
// Clients post deltas rather than absolute values, so two viewers watching at
// once both count. Deltas are clamped hard: this endpoint is open to anyone,
// so it can nudge a counter but not rewrite one.

import { route, json, readJsonBody, badRequest } from './_lib/http.js';
import { updateJSON, readJSON } from './_lib/github.js';

const PATH = 'data/stats.json';
const MAX_KEYS = 50;
const MAX_DELTA = 25;

function cleanDeltas(input) {
  const out = {};
  let n = 0;
  for (const [id, value] of Object.entries(input || {})) {
    if (typeof id !== 'string' || id.length > 120) continue;
    const delta = Math.trunc(Number(value));
    if (!Number.isFinite(delta) || delta === 0) continue;
    out[id] = Math.max(-MAX_DELTA, Math.min(MAX_DELTA, delta));
    if (++n >= MAX_KEYS) break;
  }
  return out;
}

export default route(async (req, res) => {
  if (req.method === 'GET') {
    const { data } = await readJSON(PATH);
    json(res, 200, { data: data || { views: {}, likes: {} } });
    return;
  }

  const body = await readJsonBody(req);
  const views = cleanDeltas(body.views);
  const likes = cleanDeltas(body.likes);
  if (!Object.keys(views).length && !Object.keys(likes).length) {
    throw badRequest('No counter changes supplied.');
  }

  const { data } = await updateJSON(PATH, (current) => {
    const next = { views: {}, likes: {}, ...(current || {}) };
    for (const [kind, deltas] of [['views', views], ['likes', likes]]) {
      next[kind] = { ...next[kind] };
      for (const [id, delta] of Object.entries(deltas)) {
        next[kind][id] = Math.max(0, (next[kind][id] || 0) + delta);
      }
    }
    return next;
  }, { message: 'stats: view and like counts', fallback: { views: {}, likes: {} } });

  json(res, 200, { data });
}, { methods: ['GET', 'POST'] });
