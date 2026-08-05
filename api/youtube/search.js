// YouTube search for the Studio picker.
//
// The API key stays server-side. Search returns ids only, so a second call to
// videos.list fetches durations and full descriptions — search.list doesn't
// include either.

import { route, json, query, badRequest, HttpError } from '../_lib/http.js';
import { requireAdmin } from '../_lib/auth.js';
import { searchYouTube, hydrateVideos } from './_client.js';

export default route(async (req, res) => {
  requireAdmin(req);

  const params = query(req);
  const q = String(params.q || '').trim();
  if (!q) throw badRequest('Type something to search for.');
  if (q.length > 200) throw badRequest('That search is too long.');

  if (!process.env.YOUTUBE_API_KEY) {
    throw new HttpError(503,
      'YouTube search is not configured. Set YOUTUBE_API_KEY in the environment, or paste a video URL instead.');
  }

  const found = await searchYouTube(q, {
    pageToken: String(params.pageToken || '') || undefined,
    channelId: String(params.channelId || '') || undefined,
    order: String(params.order || 'relevance'),
    duration: String(params.duration || '') || undefined,
  });

  const videos = await hydrateVideos(found.ids);

  json(res, 200, { videos, nextPageToken: found.nextPageToken || null });
});
