# YoutubeMentries

A streaming site for documentaries and docuseries — channels, subscriptions,
playlists, watch history with resume positions, search, comments, accounts with
Google sign-in, and a Studio where you pick videos off YouTube rather than
typing metadata.

Runs on Vercel. No build step and no dependencies: the front end is plain ES
modules, and the API is zero-dependency Node functions.

## Setup

1. **Deploy** — import the repo on Vercel. It works immediately, signed-out and
   read-only.
2. **Add environment variables** (Project → Settings → Environment Variables).
   Copy the names from [.env.example](.env.example):

   | Variable | Needed for | Notes |
   | --- | --- | --- |
   | `AUTH_SECRET` | sign-in | Any long random string. Rotating it signs everybody out. |
   | `GITHUB_TOKEN` | saving anything | Fine-grained token, this repo only, **Contents: Read and write**. |
   | `GITHUB_OWNER` / `GITHUB_REPO` / `GITHUB_BRANCH` | saving | Default to `e0190` / `youtubementarys` / `main`. |
   | `ADMIN_EMAILS` | Studio | Comma-separated. Empty means nobody can edit the catalog. |
   | `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Sign in with Google | Optional — the button hides when unset. |
   | `YOUTUBE_API_KEY` | searching YouTube in Studio | Optional — pasting a URL still works without it. |

3. **Redeploy** so the functions pick the variables up.

### Sign in with Google

In [Google Cloud Console](https://console.cloud.google.com) → APIs & Services →
Credentials, create an **OAuth client ID** of type *Web application*, and add
these as authorised redirect URIs:

```
https://YOUR-DOMAIN/api/auth/google/callback
http://localhost:8500/api/auth/google/callback
```

Then set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.

### Searching YouTube from Studio

Enable **YouTube Data API v3** in the same project, create an API key, and set
`YOUTUBE_API_KEY`. Search costs 100 quota units per query against a default
10,000/day allowance — roughly 100 searches a day.

Without the key, Studio still fills in a video's title and thumbnail from a
pasted URL (via YouTube's public oEmbed endpoint); you supply the duration.

## Running locally

```bash
npm run dev
```

Serves <http://localhost:8500> and mounts everything under `api/` exactly the
way Vercel routes it, `[param]` segments included.

With no `GITHUB_TOKEN` set, data is written to `.dev-storage/` instead of the
repo, seeded from `data/` on first run — so sign-up, Studio and comments all
work locally without touching production. Set `AUTH_SECRET` and `ADMIN_EMAILS`
in `.env.local` to exercise the signed-in paths.

```bash
npm run check
```

Parses every JS file, resolves every relative import, validates the JSON,
checks the catalog is referentially intact, and fails if anything that looks
like a credential appears in client code.

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
  _lib/local.js         filesystem driver, development only
  _lib/auth.js          sessions, scrypt passwords, accounts, admin checks
  auth/                 register, login, logout, session, google/{start,callback}
  me.js                 the signed-in viewer's data
  catalog/[collection]  videos | channels | series | playlists  (admin writes)
  comments/[videoId]    per-video comments
  stats.js              view and like counters
  youtube/              search + lookup for the Studio picker

assets/js/
  api.js                the only module that talks to the server
  auth.js               session state, sign-in dialog
  store.js              catalog + viewer state, search, recommendations
  sync.js               debounced background sync
  player.js             one player over YouTube IFrame + HTML5 video
  components.js         cards, chips, modals, toasts, menus
  miniplayer.js         floating player that survives navigation
  views/                one module per page
```

### Where data lives

- **Catalog** — `data/*.json` in this repo. The browser reads these as static
  files off the CDN, so browsing costs no function invocations. Studio writes go
  through `/api/catalog/*`, which commits to the repo.
- **Accounts** — `data/auth/accounts.json`. Passwords are scrypt hashes; this
  file is only ever read server-side.
- **Viewer data** — `data/users/<id>.json`: subscriptions, history, resume
  positions, ratings, playlists.
- **Comments** — `data/comments/<videoId>.json`, one file per video.

GitHub-as-a-database is fine at this size and free, but every write is a commit.
If this ever grows past a few hundred active viewers, move `_lib/storage.js` to
a real database — it's the only file that would need to change.

### Signed out is a first-class state

Nothing hides behind a login. Anyone can browse, watch, subscribe, build
playlists and keep resume positions — all stored locally. Signing in adopts that
local data into the account and starts syncing it across devices. Only comments
require an account, and only administrators can touch the catalog.

### Two playback engines, one set of controls

Each video declares its own source:

```jsonc
"source": { "type": "youtube", "youtubeId": "aqz-KE-bpKQ" }

"source": {
  "type": "file",
  "src": "https://example.com/film.mp4",
  "poster": "https://example.com/poster.jpg",
  "captions": [{ "lang": "en", "label": "English", "src": "https://…/en.vtt" }]
}
```

`player.js` wraps both behind one interface, so the custom control bar, keyboard
shortcuts, resume positions, theater mode and the miniplayer behave identically
either way. YouTube runs with `controls: 0`, driven through the IFrame API.

## Adding content

Studio (`#/studio`, administrators only):

- **Add from YouTube** — search, tick the ones you want, and they're added with
  title, description, duration, thumbnail and publish date filled in. Assign a
  channel, series and topics for the whole batch at once; episode numbers
  continue from what the season already has.
- **Add a video** — for hosted files, or for a single pasted URL.

Editing `data/*.json` by hand works too, and is the only way to reorder a
playlist.

## Keyboard shortcuts

`k`/`space` play-pause · `j`/`l` ±10s · `←`/`→` ±5s · `↑`/`↓` volume ·
`0`–`9` jump to 0–90% · `m` mute · `f` full screen · `t` theater ·
`i` miniplayer · `c` subtitles · `n` next · `,`/`.` speed · `/` focus search

## About the seeded catalog

The titles that ship with this repo are public-domain documentaries from the
[Prelinger Archives](https://archive.org/details/prelinger) at the Internet
Archive, streamed from `archive.org`, plus a couple of YouTube-sourced entries
so both playback engines are exercised. Replace them whenever you like — nothing
in the code depends on them.
