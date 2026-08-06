// Comments, one file per video.
//
// GET is public. Posting requires a session, and the author is taken from that
// session rather than the request body.

import { route, json, readJsonBody, query, badRequest, notFound } from '../_lib/http.js';
import { requireSession, isAdmin } from '../_lib/auth.js';
import { readJSON, updateJSON } from '../_lib/storage.js';

const MAX_COMMENTS = 500;
const MAX_LENGTH = 2000;

const path = (videoId) => `data/comments/${videoId}.json`;

function videoIdOf(req) {
  const raw = req.query?.videoId ?? query(req).videoId;
  const id = String(raw || '').trim();
  if (!id || !/^[\w.-]{1,120}$/.test(id)) throw badRequest('Invalid video id.');
  return id;
}

export default route(async (req, res) => {
  const videoId = videoIdOf(req);

  if (req.method === 'GET') {
    const { data } = await readJSON(path(videoId));
    json(res, 200, { comments: data?.comments || [] });
    return;
  }

  if (req.method === 'DELETE') {
    const session = requireSession(req);
    const body = await readJsonBody(req);
    const commentId = String(body.id || '');
    if (!commentId) throw badRequest('Which comment?');

    let removed = false;
    await updateJSON(path(videoId), (data) => {
      const list = data?.comments || [];
      const target = list.find((c) => c.id === commentId);
      if (!target) return undefined;
      // Your own comments, or anything if you administer the site.
      if (target.authorId !== session.sub && !isAdmin(session)) return undefined;
      removed = true;
      return { videoId, comments: list.filter((c) => c.id !== commentId) };
    }, { message: `comments: remove from ${videoId}`, fallback: { videoId, comments: [] } });

    if (!removed) throw notFound('That comment is not yours, or no longer exists.');
    json(res, 200, { ok: true });
    return;
  }

  // POST
  const session = requireSession(req);
  const body = await readJsonBody(req);
  const text = String(body.text ?? '').trim().slice(0, MAX_LENGTH);
  if (!text) throw badRequest('Write something first.');

  const comment = {
    id: `c_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    author: session.name || 'Viewer',
    authorId: session.sub,
    text,
    at: new Date().toISOString(),
    likes: 0,
  };

  await updateJSON(path(videoId), (data) => {
    const list = data?.comments || [];
    return { videoId, comments: [comment, ...list].slice(0, MAX_COMMENTS) };
  }, { message: `comments: new comment on ${videoId}`, fallback: { videoId, comments: [] } });

  json(res, 201, { comment });
}, { methods: ['GET', 'POST', 'DELETE'] });
