// Studio — manage the catalog.
//
// Requires an admin session. Every write goes through /api/catalog/*, which
// holds the GitHub credentials server-side; nothing sensitive reaches this file.
//
// Adding videos is a picker, not a form: search YouTube, tick what you want,
// and the metadata comes back filled in.

import { el, slugify, uid, parseYouTubeId, timecode, compact, longDate, debounce, setChildren } from '../util.js';
import { TOPICS } from '../config.js';
import { api } from '../api.js';
import { auth, isAdmin, isSignedIn, promptSignIn } from '../auth.js';
import { store, loadCatalog, getChannel, videosOfChannel } from '../store.js';
import {
  button, toast, modal, confirmDialog, emptyState, svgIcon, iconButton, tabs, avatar,
} from '../components.js';
import { navigate, href } from '../router.js';
import { setView } from '../app.js';

const TABS = [
  { id: 'videos', label: 'Videos' },
  { id: 'channels', label: 'Channels' },
  { id: 'series', label: 'Series' },
  { id: 'playlists', label: 'Playlists' },
];

export default function studioView({ query = {} }) {
  if (!isSignedIn()) {
    setView(emptyState('studio', 'Studio is for administrators',
      auth.features.auth
        ? 'Sign in with an administrator account to manage the catalog.'
        : 'Accounts aren’t configured on this deployment, so Studio is unavailable. See the README for the environment variables it needs.',
      auth.features.auth
        ? button('Sign in', {
            variant: 'primary',
            onClick: () => promptSignIn({ reason: 'Studio needs an administrator account.' })
              .then((user) => { if (user) studioView({ query }); }),
          })
        : null),
      { title: 'Studio' });
    return;
  }

  if (!isAdmin()) {
    setView(emptyState('studio', 'You don’t have Studio access',
      `${auth.user.email} isn’t on the administrator list. Add it to the ADMIN_EMAILS environment variable and sign in again.`,
      button('Back to home', { variant: 'primary', onClick: () => navigate('/') })),
      { title: 'Studio' });
    return;
  }

  const tab = TABS.some((t) => t.id === query.tab) ? query.tab : 'videos';
  const panels = { videos: videosPanel, channels: channelsPanel, series: seriesPanel, playlists: playlistsPanel };

  setView([
    el('div', { class: 'page-head' },
      el('h1', { class: 'page-title' }, 'Studio'),
      el('p', { class: 'page-sub' },
        `Signed in as ${auth.user.email}. Changes are published straight to the catalog.`)),
    tabs(TABS, tab, (id) => navigate('/studio', { tab: id })),
    panels[tab](),
  ], { title: 'Studio' });
}

const currentQuery = () => Object.fromEntries(new URLSearchParams(location.hash.split('?')[1] || ''));
const rerender = () => studioView({ query: currentQuery() });

/* ---------- save helpers ---------- */

async function saveItem(collection, item, label) {
  const pending = toast('Saving…', { duration: 30000 });
  try {
    await api.saveItem(collection, item);
    await loadCatalog({ fresh: true });
    pending.remove();
    toast(`${label} saved`);
    return true;
  } catch (err) {
    pending.remove();
    toast(`Save failed: ${err.message}`, { duration: 8000 });
    return false;
  }
}

async function removeItem(collection, id, label) {
  try {
    await api.deleteItem(collection, id);
    await loadCatalog({ fresh: true });
    toast(`${label} deleted`);
    return true;
  } catch (err) {
    toast(`Delete failed: ${err.message}`, { duration: 8000 });
    return false;
  }
}

/* ---------- shared form bits ---------- */

function field(label, control, hint = null) {
  return el('div', { class: 'form-row' },
    el('label', { class: 'form-label' }, label),
    control,
    hint ? el('div', { class: 'form-hint' }, hint) : null);
}

function textInput(value = '', attrs = {}) {
  const input = el('input', { class: 'input', ...attrs });
  input.value = value ?? '';
  return input;
}

function textArea(value = '', attrs = {}) {
  const area = el('textarea', { class: 'textarea', ...attrs });
  area.value = value ?? '';
  return area;
}

function selectInput(options, value, attrs = {}) {
  return el('select', { class: 'select', ...attrs },
    ...options.map(([v, label]) => el('option', { value: v, selected: v === value || null }, label)));
}

function topicPicker(selected = []) {
  const chosen = new Set(selected);
  const bar = el('div', { class: 'chipbar', style: { position: 'static', paddingBottom: '.25rem', flexWrap: 'wrap' } });
  for (const topic of TOPICS) {
    const chip = el('button', {
      type: 'button',
      class: `chip${chosen.has(topic) ? ' is-active' : ''}`,
      onclick: () => {
        if (chosen.has(topic)) chosen.delete(topic); else chosen.add(topic);
        chip.classList.toggle('is-active', chosen.has(topic));
      },
    }, topic);
    bar.append(chip);
  }
  bar.getValue = () => [...chosen];
  return bar;
}

/** "1:02:33" or "3753" -> seconds */
function parseDuration(input) {
  const s = String(input || '').trim();
  if (!s) return 0;
  if (/^\d+$/.test(s)) return Number(s);
  const parts = s.split(':').map(Number);
  if (parts.some(Number.isNaN)) return 0;
  return parts.reduce((total, part) => total * 60 + part, 0);
}

function table(headers, rows) {
  return el('div', { class: 'table-scroll' },
    el('table', { class: 'data-table' },
      el('thead', {}, el('tr', {}, ...headers.map((h) => el('th', {}, h)))),
      el('tbody', {}, ...rows)));
}

/** Stable, readable, collision-resistant id from a title. */
function makeId(prefix, title, seed = '') {
  const slug = slugify(title).slice(0, 48);
  const suffix = seed ? seed.slice(0, 6).toLowerCase().replace(/[^a-z0-9]/g, '') : '';
  return `${prefix}_${slug || uid('x')}${suffix ? `_${suffix}` : ''}`;
}

function requireChannel(onReady) {
  if (store.catalog.channels.length) { onReady(); return; }
  modal({
    title: 'Add a channel first',
    body: el('p', {}, 'Videos belong to a channel. Create one on the Channels tab, then come back.'),
    actions: [{ label: 'Go to Channels', variant: 'primary', onClick: () => navigate('/studio', { tab: 'channels' }) }],
  });
}

/* ---------- videos ---------- */

function videosPanel() {
  const videos = store.catalog.videos.slice()
    .sort((a, b) => new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0));

  const rows = videos.map((v) => {
    const channel = getChannel(v.channelId);
    return el('tr', {},
      el('td', {},
        el('a', { href: href('/watch', { v: v.id }), style: { fontWeight: '600' } }, v.title),
        el('div', { class: 'muted', style: { fontSize: '.78rem' } }, v.id)),
      el('td', {}, channel?.name || el('span', { class: 'muted' }, 'unknown')),
      el('td', {}, v.source?.type === 'youtube' ? 'YouTube' : 'File'),
      el('td', {}, timecode(v.durationSec)),
      el('td', {}, compact(v.views || 0)),
      el('td', {}, v.publishedAt ? longDate(v.publishedAt) : '—'),
      el('td', {}, el('div', { class: 'row-actions' },
        iconButton('settings', 'Edit', () => openVideoForm(v), { size: 18 }),
        iconButton('trash', 'Delete', async () => {
          const ok = await confirmDialog('Delete this video?',
            `“${v.title}” will be removed from the catalog.`);
          if (ok && await removeItem('videos', v.id, 'Video')) rerender();
        }, { size: 18 }))));
  });

  // Without an API key there is nothing to search, so the primary action goes
  // straight to the form — where pasting a URL still fills in what it can.
  const addButtons = el('div', { class: 'section-actions' },
    auth.features.youtubeSearch
      ? button('Add from YouTube', {
          variant: 'primary', icon: 'search',
          onClick: () => requireChannel(() => openYouTubePicker()),
        })
      : null,
    button(auth.features.youtubeSearch ? 'Add manually' : 'Add a video', {
      variant: auth.features.youtubeSearch ? 'subtle' : 'primary', icon: 'plus',
      onClick: () => requireChannel(() => openVideoForm(null)),
    }));

  return el('div', {},
    auth.features.youtubeSearch
      ? null
      : el('div', { class: 'banner banner-warn' },
          svgIcon('search', 20),
          el('div', {},
            el('div', { class: 'banner-title' }, 'YouTube search isn’t configured'),
            el('div', { class: 'muted' },
              'Set YOUTUBE_API_KEY to search and pick videos. Without it you can still paste a video URL — the details are filled in for you where possible.'))),

    el('div', { class: 'section-head', style: { marginTop: '0' } },
      el('h2', { class: 'section-title' }, `${videos.length} ${videos.length === 1 ? 'video' : 'videos'}`),
      addButtons),

    videos.length
      ? table(['Title', 'Channel', 'Source', 'Length', 'Views', 'Published', ''], rows)
      : emptyState('film', 'No videos yet',
          auth.features.youtubeSearch
            ? 'Search YouTube and pick what belongs in your catalog.'
            : 'Paste a YouTube URL and the details are filled in for you.',
          button(auth.features.youtubeSearch ? 'Add from YouTube' : 'Add a video', {
            variant: 'primary',
            onClick: () => requireChannel(() =>
              (auth.features.youtubeSearch ? openYouTubePicker() : openVideoForm(null))),
          })));
}

/* ---------- the YouTube picker ---------- */

function openYouTubePicker() {
  const selected = new Map();   // youtubeId -> video metadata
  let results = [];
  let nextPageToken = null;
  let lastQuery = '';
  let busy = false;

  const resultsHost = el('div', { class: 'picker-grid' });
  const statusLine = el('div', { class: 'picker-status muted' });
  const trayCount = el('span', { class: 'picker-tray-count' }, '0 selected');
  const moreBtn = el('button', { class: 'btn btn-subtle', hidden: true, onclick: () => run(lastQuery, true) }, 'Load more');

  const searchInput = el('input', {
    class: 'input picker-search', type: 'search',
    placeholder: 'Search YouTube — or paste a video URL',
    autocomplete: 'off',
  });
  const orderSelect = selectInput(
    [['relevance', 'Most relevant'], ['viewCount', 'Most viewed'], ['date', 'Newest'], ['rating', 'Top rated']],
    'relevance');
  const durationSelect = selectInput(
    [['', 'Any length'], ['long', 'Over 20 min'], ['medium', '4–20 min'], ['short', 'Under 4 min']], '');

  const channelSelect = selectInput(
    store.catalog.channels.map((c) => [c.id, c.name]), store.catalog.channels[0]?.id);
  const seriesSelect = selectInput(
    [['', 'Not part of a series'], ...store.catalog.series.map((s) => [s.id, s.title])], '');
  const seasonInput = textInput('1', { type: 'number', min: '1', style: { maxWidth: '6rem' } });
  const topics = topicPicker([]);

  const addBtn = button('Add selected', {
    variant: 'primary',
    disabled: true,
    onClick: () => commit(),
  });

  function setBusy(on, message = '') {
    busy = on;
    statusLine.textContent = message;
    searchInput.disabled = on;
  }

  function paintResults() {
    if (!results.length) {
      setChildren(resultsHost);
      return;
    }
    setChildren(resultsHost, ...results.map((v) => {
      const chosen = selected.has(v.youtubeId);
      const already = store.catalog.videos.some(
        (x) => x.source?.type === 'youtube' && x.source.youtubeId === v.youtubeId);

      const card = el('button', {
        type: 'button',
        class: `picker-card${chosen ? ' is-selected' : ''}${already ? ' is-existing' : ''}`,
        'aria-pressed': String(chosen),
        title: already ? 'Already in your catalog' : v.title,
        onclick: () => {
          if (selected.has(v.youtubeId)) selected.delete(v.youtubeId);
          else selected.set(v.youtubeId, v);
          paintResults();
          paintTray();
        },
      },
        el('span', { class: 'picker-thumb' },
          v.thumbnail
            ? el('img', { src: v.thumbnail, alt: '', loading: 'lazy' })
            : el('span', { class: 'thumb-placeholder' }, svgIcon('film', 24)),
          el('span', { class: 'thumb-duration' }, timecode(v.durationSec)),
          chosen ? el('span', { class: 'picker-tick' }, svgIcon('check', 18)) : null,
          already ? el('span', { class: 'picker-existing' }, 'In catalog') : null),
        el('span', { class: 'picker-card-title' }, v.title),
        el('span', { class: 'picker-card-meta' },
          [v.channelTitle, `${compact(v.views)} views`, v.publishedAt?.slice(0, 4)]
            .filter(Boolean).join(' · ')));
      return card;
    }));
  }

  function paintTray() {
    const n = selected.size;
    trayCount.textContent = `${n} selected`;
    addBtn.disabled = n === 0;
    addBtn.querySelector('span').textContent = n ? `Add ${n} video${n === 1 ? '' : 's'}` : 'Add selected';
  }

  async function run(q, append = false) {
    if (busy) return;
    const term = q.trim();
    if (!term) return;
    lastQuery = term;

    // A pasted URL doesn't need a search — go straight to a lookup.
    const pastedId = parseYouTubeId(term);
    if (pastedId && !append) {
      setBusy(true, 'Looking up that video…');
      try {
        const { videos } = await api.lookupYouTube(pastedId);
        results = videos;
        nextPageToken = null;
        moreBtn.hidden = true;
        if (!videos.length) setBusy(false, 'No video found with that id.');
        else setBusy(false, `Found “${videos[0].title}”.`);
        // A single pasted video is almost certainly the one they want.
        if (videos.length === 1) selected.set(videos[0].youtubeId, videos[0]);
        paintResults();
        paintTray();
      } catch (err) {
        setBusy(false, err.message);
      }
      return;
    }

    if (!auth.features.youtubeSearch) {
      setBusy(false, 'Search isn’t configured — paste a YouTube URL instead.');
      return;
    }

    setBusy(true, append ? 'Loading more…' : 'Searching YouTube…');
    try {
      const data = await api.searchYouTube({
        q: term,
        order: orderSelect.value,
        duration: durationSelect.value,
        ...(append && nextPageToken ? { pageToken: nextPageToken } : {}),
      });
      results = append ? [...results, ...data.videos] : data.videos;
      nextPageToken = data.nextPageToken;
      moreBtn.hidden = !nextPageToken;
      setBusy(false, results.length
        ? `${results.length} result${results.length === 1 ? '' : 's'}`
        : 'Nothing matched that search.');
      paintResults();
      paintTray();
    } catch (err) {
      setBusy(false, err.message);
    }
  }

  async function commit() {
    const channelId = channelSelect.value;
    const seriesId = seriesSelect.value || null;
    const season = Number(seasonInput.value) || 1;
    const chosenTopics = topics.getValue();

    const items = [...selected.values()];
    addBtn.disabled = true;
    const pending = toast(`Adding ${items.length} video${items.length === 1 ? '' : 's'}…`, { duration: 120000 });

    // Continue numbering after whatever the series already has.
    let episode = seriesId
      ? store.catalog.videos.filter((v) => v.seriesId === seriesId && (v.season || 1) === season).length + 1
      : 1;

    let added = 0;
    const failures = [];

    for (const v of items) {
      const record = {
        id: makeId('v', v.title, v.youtubeId),
        title: v.title.slice(0, 200),
        channelId,
        description: v.description || '',
        publishedAt: v.publishedAt || new Date().toISOString().slice(0, 10),
        durationSec: v.durationSec,
        topics: chosenTopics,
        tags: v.tags || [],
        views: v.views || 0,
        likes: v.likes || 0,
        thumbnail: v.thumbnail || null,
        source: { type: 'youtube', youtubeId: v.youtubeId },
        ...(v.publishedAt ? { year: Number(v.publishedAt.slice(0, 4)) } : {}),
        ...(seriesId ? { seriesId, season, episode: episode++ } : {}),
      };
      try {
        await api.saveItem('videos', record);
        added += 1;
      } catch (err) {
        failures.push(`${v.title}: ${err.message}`);
      }
    }

    pending.remove();
    await loadCatalog({ fresh: true });

    if (failures.length) {
      toast(`Added ${added}, ${failures.length} failed. ${failures[0]}`, { duration: 9000 });
    } else {
      toast(`Added ${added} video${added === 1 ? '' : 's'}`);
    }
    dialog.close();
    rerender();
  }

  const debouncedSearch = debounce(() => run(searchInput.value), 500);
  searchInput.addEventListener('input', () => {
    // Pasted URLs resolve instantly; typed queries wait for a pause.
    if (parseYouTubeId(searchInput.value.trim())) run(searchInput.value);
    else debouncedSearch();
  });
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); debouncedSearch.cancel(); run(searchInput.value); }
  });
  orderSelect.addEventListener('change', () => run(lastQuery));
  durationSelect.addEventListener('change', () => run(lastQuery));

  const dialog = modal({
    title: 'Add videos from YouTube',
    wide: true,
    body: el('div', { class: 'picker' },
      el('div', { class: 'picker-controls' },
        searchInput,
        auth.features.youtubeSearch ? orderSelect : null,
        auth.features.youtubeSearch ? durationSelect : null),
      statusLine,
      resultsHost,
      el('div', { style: { display: 'flex', justifyContent: 'center', padding: '.5rem 0' } }, moreBtn),
      el('div', { class: 'picker-settings' },
        el('div', { class: 'form-row-2' },
          field('Add to channel', channelSelect),
          field('Part of a series', seriesSelect)),
        el('div', { class: 'form-row-2' },
          field('Season', seasonInput, 'Episode numbers continue from what’s already there.'),
          field('Topics', topics)))),
    actions: [
      { label: 'Cancel', variant: 'ghost' },
    ],
  });

  // The tray sits with the dialog actions so it stays visible while scrolling.
  const actionsRow = dialog.dialog.querySelector('.modal-actions');
  actionsRow.prepend(el('div', { class: 'picker-tray' }, trayCount));
  actionsRow.append(addBtn);

  paintTray();
  searchInput.focus();
  statusLine.textContent = auth.features.youtubeSearch
    ? 'Search for a documentary, or paste a YouTube URL.'
    : 'Paste a YouTube URL to look it up.';
}

/* ---------- manual video form ---------- */

function openVideoForm(existing) {
  const isNew = !existing;
  const v = existing || {};
  const src = v.source || { type: 'youtube' };
  const channels = store.catalog.channels;

  const title = textInput(v.title, { placeholder: 'Planet Earth II: Islands', maxlength: '200' });
  const sourceType = selectInput([['youtube', 'YouTube video'], ['file', 'Hosted file (MP4/HLS)']], src.type);
  const youtubeId = textInput(src.youtubeId, { placeholder: 'Paste a YouTube URL or 11-character id' });
  const fileSrc = textInput(src.src, { placeholder: 'https://cdn.example.com/film.mp4' });
  const poster = textInput(src.poster, { placeholder: 'https://…/poster.jpg' });
  const thumbnail = textInput(v.thumbnail, { placeholder: 'Leave blank to use the YouTube thumbnail' });
  const channelId = selectInput(channels.map((c) => [c.id, c.name]), v.channelId || channels[0]?.id);
  const description = textArea(v.description, { placeholder: 'What is this documentary about?', maxlength: '5000' });
  const duration = textInput(v.durationSec ? timecode(v.durationSec) : '', { placeholder: '1:02:33 or seconds' });
  const published = textInput(v.publishedAt ? String(v.publishedAt).slice(0, 10) : new Date().toISOString().slice(0, 10), { type: 'date' });
  const year = textInput(v.year || '', { type: 'number', min: '1800', max: '2200', placeholder: '2016' });
  const rating = textInput(v.rating, { placeholder: 'TV-PG', maxlength: '12' });
  const views = textInput(v.views ?? 0, { type: 'number', min: '0' });
  const seriesId = selectInput(
    [['', 'Not part of a series'], ...store.catalog.series.map((s) => [s.id, s.title])], v.seriesId || '');
  const season = textInput(v.season || '', { type: 'number', min: '1', placeholder: '1' });
  const episode = textInput(v.episode || '', { type: 'number', min: '1', placeholder: '1' });
  const topics = topicPicker(v.topics || []);
  const errorBox = el('div', { class: 'form-error', hidden: true });

  const lookupBtn = button('Fetch details', {
    variant: 'subtle',
    onClick: async () => {
      const id = parseYouTubeId(youtubeId.value);
      if (!id) { errorBox.textContent = 'Paste a YouTube URL or id first.'; errorBox.hidden = false; return; }
      try {
        const { videos } = await api.lookupYouTube(id);
        const found = videos[0];
        if (!found) { toast('No video found with that id.'); return; }
        if (!title.value.trim()) title.value = found.title;
        if (!description.value.trim()) description.value = found.description;
        duration.value = timecode(found.durationSec);
        published.value = found.publishedAt;
        if (!year.value) year.value = found.publishedAt.slice(0, 4);
        if (!views.value || views.value === '0') views.value = String(found.views);
        toast('Details filled in from YouTube');
      } catch (err) {
        toast(err.message, { duration: 6000 });
      }
    },
  });

  const youtubeRow = field('YouTube URL or id',
    el('div', { style: { display: 'flex', gap: '.5rem' } }, youtubeId, lookupBtn),
    'Accepts youtu.be, /watch?v=, /embed/ and /shorts/ links.');
  const fileRow = field('Video file URL', fileSrc, 'A direct, CORS-enabled MP4/WebM or HLS URL.');
  const posterRow = field('Poster image', poster, 'Shown before playback starts.');

  const syncSourceRows = () => {
    const yt = sourceType.value === 'youtube';
    youtubeRow.hidden = !yt;
    fileRow.hidden = yt;
    posterRow.hidden = yt;
  };
  sourceType.addEventListener('change', syncSourceRows);
  syncSourceRows();

  modal({
    title: isNew ? 'Add video' : 'Edit video',
    wide: true,
    body: el('div', { class: 'form-grid' },
      errorBox,
      field('Title', title),
      field('Channel', channelId),
      field('Source', sourceType),
      youtubeRow, fileRow, posterRow,
      field('Custom thumbnail', thumbnail),
      field('Description', description),
      el('div', { class: 'form-row-2' }, field('Duration', duration), field('Published', published)),
      el('div', { class: 'form-row-2' }, field('Year', year), field('Rating', rating)),
      field('Starting view count', views, 'A baseline; real plays count on top of it.'),
      field('Series', seriesId),
      el('div', { class: 'form-row-2' }, field('Season', season), field('Episode', episode)),
      field('Topics', topics)),
    actions: [
      { label: 'Cancel', variant: 'ghost' },
      {
        label: isNew ? 'Publish' : 'Save changes',
        variant: 'primary',
        onClick: () => {
          const fail = (msg, focusEl) => {
            errorBox.textContent = msg;
            errorBox.hidden = false;
            focusEl?.focus();
            return false;
          };

          const name = title.value.trim();
          if (!name) return fail('A title is required.', title);

          let source;
          if (sourceType.value === 'youtube') {
            const id = parseYouTubeId(youtubeId.value);
            if (!id) return fail('That doesn’t look like a YouTube URL or video id.', youtubeId);
            source = { type: 'youtube', youtubeId: id };
          } else {
            const url = fileSrc.value.trim();
            if (!url) return fail('A video file URL is required.', fileSrc);
            source = { type: 'file', src: url, ...(poster.value.trim() ? { poster: poster.value.trim() } : {}) };
            if (Array.isArray(src.captions) && src.captions.length) source.captions = src.captions;
          }

          const seconds = parseDuration(duration.value);
          if (!seconds) return fail('Enter a duration, like 52:00 or 1:02:33.', duration);

          const record = {
            id: v.id || makeId('v', name, source.youtubeId || ''),
            title: name,
            channelId: channelId.value,
            description: description.value.trim(),
            publishedAt: published.value || new Date().toISOString().slice(0, 10),
            durationSec: seconds,
            topics: topics.getValue(),
            tags: v.tags || [],
            views: Number(views.value) || 0,
            likes: v.likes || 0,
            source,
            ...(thumbnail.value.trim() ? { thumbnail: thumbnail.value.trim() } : {}),
            ...(seriesId.value ? { seriesId: seriesId.value } : {}),
            ...(seriesId.value && season.value ? { season: Number(season.value) } : {}),
            ...(seriesId.value && episode.value ? { episode: Number(episode.value) } : {}),
            ...(year.value ? { year: Number(year.value) } : {}),
            ...(rating.value.trim() ? { rating: rating.value.trim() } : {}),
          };

          saveItem('videos', record, 'Video').then((ok) => { if (ok) rerender(); });
        },
      },
    ],
  });
}

/* ---------- channels ---------- */

function channelsPanel() {
  const rows = store.catalog.channels.map((c) => el('tr', {},
    el('td', {}, el('div', { style: { display: 'flex', alignItems: 'center', gap: '.6rem' } },
      avatar(c, 32),
      el('div', {},
        el('a', { href: href(`/channel/${c.handle || c.id}`), style: { fontWeight: '600' } }, c.name),
        el('div', { class: 'muted', style: { fontSize: '.78rem' } }, c.handle ? `@${c.handle}` : c.id)))),
    el('td', {}, compact(c.subscribers || 0)),
    el('td', {}, String(videosOfChannel(c.id).length)),
    el('td', {}, (c.topics || []).join(', ') || '—'),
    el('td', {}, el('div', { class: 'row-actions' },
      iconButton('settings', 'Edit', () => openChannelForm(c), { size: 18 }),
      iconButton('trash', 'Delete', async () => {
        const count = videosOfChannel(c.id).length;
        const ok = await confirmDialog('Delete this channel?',
          count
            ? `${c.name} still has ${count} ${count === 1 ? 'video' : 'videos'}. They stay in the catalog but show as “unknown channel”.`
            : `${c.name} will be removed.`);
        if (ok && await removeItem('channels', c.id, 'Channel')) rerender();
      }, { size: 18 })))));

  return el('div', {},
    el('div', { class: 'section-head', style: { marginTop: '0' } },
      el('h2', { class: 'section-title' }, `${store.catalog.channels.length} channels`),
      button('Add channel', { variant: 'primary', icon: 'plus', onClick: () => openChannelForm(null) })),
    store.catalog.channels.length
      ? table(['Channel', 'Subscribers', 'Videos', 'Topics', ''], rows)
      : emptyState('subs', 'No channels yet', 'Channels group your titles by publisher.',
          button('Add channel', { variant: 'primary', onClick: () => openChannelForm(null) })));
}

function openChannelForm(existing) {
  const isNew = !existing;
  const c = existing || {};

  const name = textInput(c.name, { placeholder: 'BBC Earth', maxlength: '80' });
  const handle = textInput(c.handle, { placeholder: 'bbcearth', maxlength: '40' });
  const tagline = textInput(c.tagline, { placeholder: 'One line about the channel', maxlength: '160' });
  const description = textArea(c.description, { maxlength: '3000' });
  const avatarUrl = textInput(c.avatar, { placeholder: 'https://…/avatar.jpg — blank generates a letter tile' });
  const banner = textInput(c.banner, { placeholder: 'https://…/banner.jpg' });
  const subscribers = textInput(c.subscribers ?? 0, { type: 'number', min: '0' });
  const joined = textInput(c.joined ? String(c.joined).slice(0, 10) : new Date().toISOString().slice(0, 10), { type: 'date' });
  const verified = el('input', { type: 'checkbox', checked: c.verified || null });
  const topics = topicPicker(c.topics || []);
  const errorBox = el('div', { class: 'form-error', hidden: true });

  if (isNew) {
    name.addEventListener('input', () => {
      if (!handle.dataset.touched) handle.value = slugify(name.value).replace(/-/g, '');
    });
    handle.addEventListener('input', () => { handle.dataset.touched = '1'; });
  }

  modal({
    title: isNew ? 'Add channel' : 'Edit channel',
    wide: true,
    body: el('div', { class: 'form-grid' },
      errorBox,
      field('Name', name),
      field('Handle', handle, 'Used in the URL: #/channel/handle'),
      field('Tagline', tagline),
      field('Description', description),
      field('Avatar URL', avatarUrl),
      field('Banner URL', banner),
      el('div', { class: 'form-row-2' }, field('Subscribers', subscribers), field('Joined', joined)),
      el('div', { class: 'form-row' },
        el('label', { class: 'form-label', style: { display: 'flex', alignItems: 'center', gap: '.5rem' } },
          verified, el('span', {}, 'Show a verified badge'))),
      field('Topics', topics)),
    actions: [
      { label: 'Cancel', variant: 'ghost' },
      {
        label: isNew ? 'Create channel' : 'Save changes',
        variant: 'primary',
        onClick: () => {
          const channelName = name.value.trim();
          if (!channelName) {
            errorBox.textContent = 'A name is required.';
            errorBox.hidden = false;
            name.focus();
            return false;
          }
          const cleanHandle = slugify(handle.value || channelName).replace(/-/g, '');
          const clash = store.catalog.channels.find(
            (x) => x.handle?.toLowerCase() === cleanHandle.toLowerCase() && x.id !== c.id);
          if (clash) {
            errorBox.textContent = `The handle @${cleanHandle} is already used by ${clash.name}.`;
            errorBox.hidden = false;
            handle.focus();
            return false;
          }

          const record = {
            id: c.id || `ch_${cleanHandle || uid('ch')}`,
            handle: cleanHandle,
            name: channelName,
            tagline: tagline.value.trim(),
            description: description.value.trim(),
            avatar: avatarUrl.value.trim() || null,
            banner: banner.value.trim() || null,
            verified: verified.checked,
            subscribers: Number(subscribers.value) || 0,
            joined: joined.value || new Date().toISOString().slice(0, 10),
            topics: topics.getValue(),
            links: c.links || [],
          };

          saveItem('channels', record, 'Channel').then((ok) => { if (ok) rerender(); });
        },
      },
    ],
  });
}

/* ---------- series ---------- */

function seriesPanel() {
  const rows = store.catalog.series.map((s) => {
    const episodes = store.catalog.videos.filter((v) => v.seriesId === s.id);
    return el('tr', {},
      el('td', {}, el('a', { href: href(`/series/${s.id}`), style: { fontWeight: '600' } }, s.title)),
      el('td', {}, getChannel(s.channelId)?.name || el('span', { class: 'muted' }, 'unknown')),
      el('td', {}, String(episodes.length)),
      el('td', {}, String((s.seasons || []).length || new Set(episodes.map((e) => e.season || 1)).size)),
      el('td', {}, el('div', { class: 'row-actions' },
        iconButton('settings', 'Edit', () => openSeriesForm(s), { size: 18 }),
        iconButton('trash', 'Delete', async () => {
          const ok = await confirmDialog('Delete this series?',
            episodes.length
              ? `${episodes.length} ${episodes.length === 1 ? 'episode stays' : 'episodes stay'} in the catalog as standalone titles.`
              : `“${s.title}” will be removed.`);
          if (ok && await removeItem('series', s.id, 'Series')) rerender();
        }, { size: 18 }))));
  });

  return el('div', {},
    el('div', { class: 'section-head', style: { marginTop: '0' } },
      el('h2', { class: 'section-title' }, `${store.catalog.series.length} series`),
      button('Add series', { variant: 'primary', icon: 'plus', onClick: () => openSeriesForm(null) })),
    el('div', { class: 'banner' },
      svgIcon('film', 20),
      el('div', {}, 'Episodes are assigned when you add videos — pick a series in the picker, and episode numbers continue automatically.')),
    store.catalog.series.length
      ? table(['Series', 'Channel', 'Episodes', 'Seasons', ''], rows)
      : emptyState('film', 'No series yet', 'Group multi-part documentaries into a docuseries.',
          button('Add series', { variant: 'primary', onClick: () => openSeriesForm(null) })));
}

function openSeriesForm(existing) {
  const isNew = !existing;
  const s = existing || {};
  const channels = store.catalog.channels;

  if (!channels.length) { requireChannel(() => {}); return; }

  const title = textInput(s.title, { placeholder: 'Planet Earth II', maxlength: '160' });
  const channelId = selectInput(channels.map((c) => [c.id, c.name]), s.channelId || channels[0].id);
  const description = textArea(s.description, { maxlength: '3000' });
  const poster = textInput(s.poster, { placeholder: 'https://…/poster.jpg (2:3 works best)' });
  const backdrop = textInput(s.backdrop, { placeholder: 'https://…/backdrop.jpg (wide)' });
  const topics = topicPicker(s.topics || []);
  const errorBox = el('div', { class: 'form-error', hidden: true });

  modal({
    title: isNew ? 'Add series' : 'Edit series',
    wide: true,
    body: el('div', { class: 'form-grid' },
      errorBox,
      field('Title', title),
      field('Channel', channelId),
      field('Description', description),
      field('Poster URL', poster),
      field('Backdrop URL', backdrop),
      field('Topics', topics)),
    actions: [
      { label: 'Cancel', variant: 'ghost' },
      {
        label: isNew ? 'Create series' : 'Save changes',
        variant: 'primary',
        onClick: () => {
          const name = title.value.trim();
          if (!name) {
            errorBox.textContent = 'A title is required.';
            errorBox.hidden = false;
            title.focus();
            return false;
          }
          const record = {
            id: s.id || makeId('s', name),
            title: name,
            channelId: channelId.value,
            description: description.value.trim(),
            poster: poster.value.trim() || null,
            backdrop: backdrop.value.trim() || null,
            topics: topics.getValue(),
            seasons: s.seasons || [],
          };
          saveItem('series', record, 'Series').then((ok) => { if (ok) rerender(); });
        },
      },
    ],
  });
}

/* ---------- published playlists ---------- */

function playlistsPanel() {
  const rows = store.catalog.playlists.map((p) => el('tr', {},
    el('td', {}, el('a', { href: href(`/playlist/${p.id}`), style: { fontWeight: '600' } }, p.title)),
    el('td', {}, getChannel(p.channelId)?.name || '—'),
    el('td', {}, String((p.videoIds || []).length)),
    el('td', {}, el('div', { class: 'row-actions' },
      iconButton('settings', 'Edit', () => openPlaylistForm(p), { size: 18 }),
      iconButton('trash', 'Delete', async () => {
        const ok = await confirmDialog('Delete this playlist?',
          `“${p.title}” will be unpublished. The videos stay in the catalog.`);
        if (ok && await removeItem('playlists', p.id, 'Playlist')) rerender();
      }, { size: 18 })))));

  return el('div', {},
    el('div', { class: 'section-head', style: { marginTop: '0' } },
      el('h2', { class: 'section-title' }, `${store.catalog.playlists.length} published playlists`),
      button('Add playlist', { variant: 'primary', icon: 'plus', onClick: () => openPlaylistForm(null) })),
    store.catalog.playlists.length
      ? table(['Playlist', 'Channel', 'Titles', ''], rows)
      : emptyState('library', 'No published playlists', 'Curate a collection that everyone sees.',
          button('Add playlist', { variant: 'primary', onClick: () => openPlaylistForm(null) })));
}

function openPlaylistForm(existing) {
  const isNew = !existing;
  const p = existing || {};
  const chosen = new Set(p.videoIds || []);

  const title = textInput(p.title, { placeholder: 'Best of the ocean', maxlength: '120' });
  const description = textArea(p.description, { maxlength: '1000' });
  const channelId = selectInput(
    [['', 'No channel'], ...store.catalog.channels.map((c) => [c.id, c.name])], p.channelId || '');

  const search = textInput('', { placeholder: 'Filter titles…', type: 'search' });
  const listHost = el('div', { class: 'picker-list' });

  const paintList = () => {
    const q = search.value.trim().toLowerCase();
    const matches = store.catalog.videos.filter((v) => !q || v.title.toLowerCase().includes(q));
    setChildren(listHost, ...(matches.length
      ? matches.map((v) => el('label', { class: 'picker-row' },
          el('input', {
            type: 'checkbox',
            checked: chosen.has(v.id) || null,
            onchange: (e) => { if (e.target.checked) chosen.add(v.id); else chosen.delete(v.id); },
          }),
          el('span', { class: 'picker-name' }, v.title),
          el('span', { class: 'picker-count' }, timecode(v.durationSec))))
      : [el('p', { class: 'muted' }, 'No titles match that filter.')]));
  };
  search.addEventListener('input', paintList);
  paintList();

  const errorBox = el('div', { class: 'form-error', hidden: true });

  modal({
    title: isNew ? 'Add playlist' : 'Edit playlist',
    wide: true,
    body: el('div', { class: 'form-grid' },
      errorBox,
      field('Title', title),
      field('Description', description),
      field('Channel', channelId),
      field('Titles', el('div', {}, search, listHost),
        'Order follows the catalog. Reorder by editing data/playlists.json directly.')),
    actions: [
      { label: 'Cancel', variant: 'ghost' },
      {
        label: isNew ? 'Publish playlist' : 'Save changes',
        variant: 'primary',
        onClick: () => {
          const name = title.value.trim();
          if (!name) {
            errorBox.textContent = 'A title is required.';
            errorBox.hidden = false;
            title.focus();
            return false;
          }
          const record = {
            id: p.id || makeId('pl', name),
            title: name,
            description: description.value.trim(),
            channelId: channelId.value || null,
            videoIds: [...chosen],
            visibility: 'public',
          };
          saveItem('playlists', record, 'Playlist').then((ok) => { if (ok) rerender(); });
        },
      },
    ],
  });
}
