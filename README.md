# YoutubeMentries

A place to post documentaries. People sign in, upload their own videos, and get
a channel of their own — with subscriptions, playlists, watch history that
resumes where you left off, search and comments around it.

Runs on Vercel. No build step and no dependencies: the front end is plain ES
modules, the API is zero-dependency Node functions.

## Setup

1. **Deploy** — import the repo on Vercel. It works immediately, signed-out and
   read-only.
2. **Add environment variables** (Project → Settings → Environment Variables).
   Names and comments are in [.env.example](.env.example):

   | Variable | Needed for | Notes |
   | --- | --- | --- |
   | `AUTH_SECRET` | sign-in | Any long random string. Rotating it signs everybody out. |
   | `GITHUB_TOKEN` | saving anything | Fine-grained token, this repo only, **Contents: Read and write**. |
   | `GITHUB_OWNER` / `GITHUB_REPO` / `GITHUB_BRANCH` | saving | Default to `e0190` / `youtubementarys` / `main`. |
   | `ADMIN_EMAILS` | Studio | Comma-separated. Empty means nobody can curate. |
   | `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Sign in with Google | Optional — the button hides when unset. |
   | `S3_*` | file uploads | Optional — people paste a link instead when unset. |

3. **Redeploy** so the functions pick the variables up.

### Sign in with Google

In [Google Cloud Console](https://console.cloud.google.com) → APIs & Services →
Credentials, create an **OAuth client ID** of type *Web application* with these
authorised redirect URIs:

```
https://YOUR-DOMAIN/api/auth/google/callback
http://localhost:8500/api/auth/google/callback
```

### Uploads

Uploads go **from the browser straight to your bucket** — never through Vercel,
which is what makes a two-gigabyte file possible on a serverless host. The
server only signs a short-lived URL good for one PUT of one object.

Any S3-compatible bucket works. **Cloudflare R2 is the one to pick for video:**
10 GB of storage free, and — unlike almost everyone else — no charge for
bandwidth out. Serving video is mostly a bandwidth bill, so this is the
difference between "free" and "surprising".

Create an R2 bucket, enable public access, add an API token, then set:

```
S3_ENDPOINT=https://<accountid>.r2.cloudflarestorage.com
S3_BUCKET=<bucket>
S3_REGION=auto
S3_ACCESS_KEY_ID=<token id>
S3_SECRET_ACCESS_KEY=<token secret>
S3_PUBLIC_BASE_URL=https://<your public bucket url or custom domain>
```

The bucket needs a CORS rule allowing the browser to upload and the player to
read:

```json
[{
  "AllowedOrigins": ["https://YOUR-DOMAIN"],
  "AllowedMethods": ["GET", "PUT", "HEAD"],
  "AllowedHeaders": ["*"],
  "ExposeHeaders": ["ETag", "Content-Length", "Content-Range", "Accept-Ranges"]
}]
```

`ExposeHeaders` matters — without range support the player can't seek.

**With no bucket configured**, the upload page still works: it reads the file's
duration and grabs a thumbnail locally, then asks for a URL to a file hosted
elsewhere. Nothing is faked — a file that never leaves the device can't be
watched by anyone else, so it has to live somewhere.

## Running locally

```bash
npm run dev
```

Serves <http://localhost:8500> and mounts everything under `api/` the way Vercel
routes it, `[param]` segments included.

With no `GITHUB_TOKEN`, data goes to `.dev-storage/` instead of the repo, seeded
from `data/` on first run. To exercise uploads without a real bucket, run the
included stub in another terminal:

```bash
node scripts/s3-stub.mjs --port 9000
```

It verifies SigV4 signatures exactly as a real bucket does, and serves files
back with CORS and range support. Point `.env.local` at it with
`S3_ENDPOINT=http://localhost:9000`, `S3_ACCESS_KEY_ID=devkey`,
`S3_SECRET_ACCESS_KEY=devsecret`.

```bash
npm run check
```

Parses every JS file, resolves every relative import, validates the JSON, checks
the catalog is referentially intact, and fails if client code contains anything
resembling a credential.

## How it fits together

```
index.html              app shell
sw.js                   service worker (never caches /api/)
vercel.json             rewrites, security headers
data/*.json             the catalog — served statically, written through the API

api/
  _lib/http.js          routing, JSON, errors, request origin
  _lib/storage.js       picks a backend: GitHub in production, files locally
  _lib/github.js        GitHub Contents API driver (holds GITHUB_TOKEN)
  _lib/auth.js          sessions, scrypt passwords, accounts
  _lib/channels.js      one channel per account, and who owns what
  _lib/s3.js            SigV4 presigning, zero dependencies
  auth/                 register, login, logout, session, google/{start,callback}
  upload/sign.js        issues one-shot presigned PUTs
  me.js                 the signed-in viewer's data
  catalog/[collection]  videos | channels | series | playlists
  comments/[videoId]    per-video comments
  stats.js              view and like counters

assets/js/
  api.js                the only module that talks to the server
  auth.js               session state, sign-in dialog
  upload.js             file probing, thumbnail capture, XHR upload
  store.js              catalog + viewer state, search, recommendations
  player.js             <video> wrapped in custom controls
  views/                one module per page, including views/upload.js
```

### Who can do what

- **Signed out** — browse, watch, subscribe, build playlists, keep resume
  positions. All stored locally on the device. Nothing hides behind a login.
- **Signed in** — everything above, synced across devices, plus posting videos
  and commenting. Signing in adopts whatever you did as a guest rather than
  discarding it.
- **Your own channel** — created automatically the first time you post. You can
  edit it and delete your own videos, and nothing else. Verification badges and
  subscriber counts are not self-declarable.
- **Admins** (`ADMIN_EMAILS`) — Studio: curate anything, build series and
  published playlists, remove anything that shouldn't be here.

Ownership is structural: a channel's id is derived from its owner's account id,
so `ch_u_abc` can only ever belong to `u_abc`. Posting to someone else's channel
doesn't fail with an error — it quietly re-homes onto your own.

### Where data lives

- **Catalog** — `data/*.json` in this repo, read by the browser as static files
  off the CDN so browsing costs no function invocations.
- **Accounts** — `data/auth/accounts.json`. Passwords are scrypt hashes, read
  server-side only.
- **Viewer data** — `data/users/<id>.json`.
- **Comments** — `data/comments/<videoId>.json`.
- **Video files** — your bucket. Never the repo.

GitHub-as-a-database is free and fine at this size, but every write is a commit.
Past a few hundred active posters, swap `_lib/storage.js` for a real database —
it's the only file that would need to change.

## Keyboard shortcuts

`k`/`space` play-pause · `j`/`l` ±10s · `←`/`→` ±5s · `↑`/`↓` volume ·
`0`–`9` jump to 0–90% · `m` mute · `f` full screen · `t` theater ·
`i` miniplayer · `c` subtitles · `n` next · `,`/`.` speed · `/` focus search

## About the seeded catalog

The titles that ship with this repo are public-domain documentaries from the
[Prelinger Archives](https://archive.org/details/prelinger), streamed from
`archive.org`. They're there so the site isn't empty on day one — delete them
whenever you like, nothing depends on them.
