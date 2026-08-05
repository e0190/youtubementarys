// Thin YouTube Data API v3 client. Used by the Studio picker only.

import { HttpError } from '../_lib/http.js';

const BASE = 'https://www.googleapis.com/youtube/v3';

const key = () => {
  const value = process.env.YOUTUBE_API_KEY;
  if (!value) {
    throw new HttpError(503,
      'YouTube lookups are not configured. Set YOUTUBE_API_KEY in the environment.');
  }
  return value;
};

async function call(endpoint, params) {
  const url = new URL(`${BASE}/${endpoint}`);
  for (const [k, v] of Object.entries({ ...params, key: key() })) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  }

  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json();
      detail = body.error?.message || detail;
      // The quota message is the one people actually hit, so name it plainly.
      if (body.error?.errors?.some((e) => e.reason === 'quotaExceeded')) {
        throw new HttpError(429, 'The YouTube API quota for today is used up. Try again tomorrow, or paste a URL instead.');
      }
    } catch (err) {
      if (err instanceof HttpError) throw err;
    }
    throw new HttpError(502, `YouTube API error: ${detail}`);
  }
  return res.json();
}

/** ISO 8601 duration (PT1H2M33S) -> seconds. */
export function parseISODuration(value) {
  const m = String(value || '').match(/^P(?:(\d+)D)?T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!m) return 0;
  const [, d, h, min, s] = m.map((x) => (x ? Number(x) : 0));
  return d * 86400 + h * 3600 + min * 60 + s;
}

function bestThumb(thumbnails = {}) {
  return (thumbnails.maxres || thumbnails.standard || thumbnails.high
    || thumbnails.medium || thumbnails.default || {}).url || null;
}

export async function searchYouTube(q, { pageToken, channelId, order = 'relevance', duration } = {}) {
  const body = await call('search', {
    part: 'id',
    type: 'video',
    maxResults: 24,
    q,
    order: ['relevance', 'date', 'viewCount', 'rating', 'title'].includes(order) ? order : 'relevance',
    videoDuration: ['short', 'medium', 'long'].includes(duration) ? duration : undefined,
    videoEmbeddable: 'true', // no point offering videos this site can't play
    channelId,
    pageToken,
    safeSearch: 'none',
  });

  return {
    ids: (body.items || []).map((i) => i.id?.videoId).filter(Boolean),
    nextPageToken: body.nextPageToken,
  };
}

/** Full details for up to 50 ids, shaped the way the Studio form wants them. */
export async function hydrateVideos(ids) {
  const wanted = (Array.isArray(ids) ? ids : []).filter((id) => /^[\w-]{11}$/.test(id)).slice(0, 50);
  if (!wanted.length) return [];

  const body = await call('videos', {
    part: 'snippet,contentDetails,statistics,status',
    id: wanted.join(','),
    maxResults: 50,
  });

  return (body.items || []).map((item) => ({
    youtubeId: item.id,
    title: item.snippet?.title || '',
    description: item.snippet?.description || '',
    channelTitle: item.snippet?.channelTitle || '',
    channelId: item.snippet?.channelId || '',
    publishedAt: (item.snippet?.publishedAt || '').slice(0, 10),
    thumbnail: bestThumb(item.snippet?.thumbnails),
    durationSec: parseISODuration(item.contentDetails?.duration),
    views: Number(item.statistics?.viewCount || 0),
    likes: Number(item.statistics?.likeCount || 0),
    tags: (item.snippet?.tags || []).slice(0, 20),
    embeddable: item.status?.embeddable !== false,
    url: `https://www.youtube.com/watch?v=${item.id}`,
  }));
}
