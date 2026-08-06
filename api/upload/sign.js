// Issue a one-shot presigned PUT so the browser can upload straight to the
// bucket. Signed-in people only, one object per call, size and type checked
// before anything is signed.

import { route, json, readJsonBody, badRequest, HttpError } from '../_lib/http.js';
import { requireSession } from '../_lib/auth.js';
import {
  presign, publicUrl, objectKey, isConfigured, config,
  ALLOWED_VIDEO_TYPES, ALLOWED_IMAGE_TYPES,
} from '../_lib/s3.js';

export default route(async (req, res) => {
  const session = requireSession(req);

  if (!isConfigured()) {
    throw new HttpError(503,
      'Uploads are not configured on this deployment. Paste a link to a file you host elsewhere instead.');
  }

  const body = await readJsonBody(req);
  const kind = body.kind === 'thumbnail' ? 'thumbnail' : 'video';
  const contentType = String(body.contentType || '').toLowerCase().split(';')[0].trim();
  const size = Number(body.size) || 0;

  const allowed = kind === 'thumbnail' ? ALLOWED_IMAGE_TYPES : ALLOWED_VIDEO_TYPES;
  if (!allowed.includes(contentType)) {
    throw badRequest(kind === 'thumbnail'
      ? 'Thumbnails must be a JPEG, PNG or WebP image.'
      : `That file type isn’t supported. Use ${ALLOWED_VIDEO_TYPES.map((t) => t.split('/')[1]).join(', ')}.`);
  }

  const limit = kind === 'thumbnail' ? 8 * 1024 * 1024 : config.maxBytes;
  if (!size) throw badRequest('The file appears to be empty.');
  if (size > limit) {
    const mb = Math.round(limit / (1024 * 1024));
    throw badRequest(`That file is too large. The limit is ${mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`}.`);
  }

  const key = objectKey({ userId: session.sub, kind, filename: body.filename, contentType });

  json(res, 200, {
    uploadUrl: presign(key, { method: 'PUT', contentType, expiresIn: 900 }),
    publicUrl: publicUrl(key),
    key,
    contentType,
    expiresIn: 900,
  });
}, { methods: ['POST'] });
