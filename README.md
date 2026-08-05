# YoutubeMentries

A streaming site for documentaries and docuseries — channels, subscriptions,
playlists, watch history with resume positions, search, comments, and a Studio
for managing the catalog.

No build step, no framework, no dependencies. Plain ES modules and CSS, served
as static files.

## Running it

Any static file server works. It must be served over HTTP — opening
`index.html` from the filesystem will fail, because ES modules can't load over
`file://`.

```bash
python -m http.server 8422
```

Then open <http://localhost:8422>.

## How it fits together

```
index.html            app shell — topbar, sidebar, main region
404.html              redirects unknown paths back to the app (GitHub Pages)
sw.js                 service worker: cached shell, network-first data
data/*.json           the catalog
assets/css/app.css    all styling; dark and light themes
assets/js/
  config.js           repo coordinates, topics, defaults  ← edit this first
  util.js             DOM builders, formatting, storage, base64
  github.js           Contents API client (read, write, conflict retries)
  store.js            catalog + viewer state, search, recommendations
  sync.js             background push of viewer data to the repo
  router.js           hash router
  player.js           unified player: YouTube IFrame + HTML5 video
  components.js       cards, chips, modals, toasts, menus
  miniplayer.js       floating player that survives navigation
  app.js              bootstrap, chrome, routes
  views/              one module per page
```

### Two playback engines, one set of controls

Each video declares its own source:

```jsonc
// streams from YouTube via the IFrame API
"source": { "type": "youtube", "youtubeId": "aqz-KE-bpKQ" }

// streams a file you host
"source": {
  "type": "file",
  "src": "https://example.com/film.mp4",
  "poster": "https://example.com/poster.jpg",
  "captions": [{ "lang": "en", "label": "English", "src": "https://…/en.vtt" }]
}
```

`player.js` wraps both behind one interface, so the custom control bar, keyboard
shortcuts, resume positions, theater mode and the miniplayer all behave
identically regardless of where a video comes from. YouTube videos run with
`controls: 0` and are driven through the IFrame API.

Captions on hosted files need the file server to send CORS headers. YouTube
captions are toggled through the IFrame API and need nothing.

### Data model

`data/videos.json` is the catalog. A video points at a channel
(`channelId`) and optionally at a series (`seriesId` + `season` + `episode`).
`data/series.json` lists seasons explicitly so episode order is yours to
control. `data/playlists.json` holds published playlists; playlists a viewer
creates for themselves stay in their own profile.

`data/stats.json` accumulates play and like counts on top of the baseline
numbers in the catalog.

Referential integrity is not enforced at runtime — a video pointing at a
channel that doesn't exist renders as "unknown channel" rather than crashing.

## Storage, and the token question

Everything works with no GitHub token at all. The catalog is read anonymously
from `raw.githubusercontent.com`, and a viewer's subscriptions, history, resume
positions, likes and playlists live in their browser's localStorage. This is
the default and it is safe to deploy publicly.

Adding a token in **Settings → GitHub sync** additionally lets that browser:

- publish catalog edits from Studio (commits to `data/*.json`)
- back up viewer data to `data/users/<id>.json`
- publish comments to `data/comments/<videoId>.json`

Tokens entered in Settings are stored only in that browser.

> **Do not put a token in `config.js` for a public deployment.** Anything in
> `REPO.token` is shipped to every visitor and readable straight out of the page
> source — it is not a secret, it is a published credential. If you need
> visitors to write without each holding their own token, put a small
> authenticated proxy in front of the API instead.

Writes use read-modify-write with retries on sha conflicts, so two people
editing different records in the same file won't clobber each other. Two people
editing the *same* record still resolves last-write-wins.

## Adding content

Studio (`#/studio`) covers the normal path: add a channel, then a series if you
need one, then videos. Duration accepts either `1:02:33` or a raw number of
seconds. Paste any YouTube URL — `youtu.be`, `/watch?v=`, `/embed/` and
`/shorts/` links all resolve to the right id.

Editing `data/*.json` by hand works just as well, and is the only way to reorder
a playlist.

## Keyboard shortcuts

`k`/`space` play-pause · `j`/`l` ±10s · `←`/`→` ±5s · `↑`/`↓` volume ·
`0`–`9` jump to 0–90% · `m` mute · `f` full screen · `t` theater ·
`i` miniplayer · `c` subtitles · `n` next · `,`/`.` speed · `/` focus search

## Deploying to GitHub Pages

Settings → Pages → deploy from the `main` branch, root folder. The app uses hash
routing, so deep links survive a refresh with no rewrite rules; `404.html` is
there to catch anything that still lands outside the app.

Bump `CACHE_VERSION` in `sw.js` whenever you change files under `assets/`, or
returning visitors will keep the previously cached bundle.

## About the seeded catalog

The titles that ship with this repo are public-domain documentaries from the
[Prelinger Archives](https://archive.org/details/prelinger) at the Internet
Archive, streamed directly from `archive.org`. Two entries stream from YouTube
instead, so both playback engines are exercised out of the box. Replace them
with your own catalog whenever you like — nothing in the code depends on them.
