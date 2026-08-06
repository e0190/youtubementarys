// Who am I, and what can this deployment do?
//
// The client calls this on boot: it decides whether to show "Sign in" or an
// account menu, whether the Google button appears, and whether Studio is
// reachable.

import { route, json } from '../_lib/http.js';
import { currentSession, isAdmin, authConfigured } from '../_lib/auth.js';
import { isConfigured as storageConfigured } from '../_lib/storage.js';
import { isConfigured as uploadsConfigured } from '../_lib/s3.js';

export default route(async (req, res) => {
  const session = currentSession(req);

  json(res, 200, {
    user: session
      ? {
          id: session.sub,
          email: session.email,
          name: session.name,
          isAdmin: isAdmin(session),
        }
      : null,
    features: {
      auth: authConfigured() && storageConfigured(),
      google: Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
      storage: storageConfigured(),
      uploads: uploadsConfigured(),
    },
  });
});
