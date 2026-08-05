// Studio — add and edit the catalog. Every save is a commit to data/*.json
// through the GitHub Contents API, so a token with write access is required.

import { el, slugify, uid, parseYouTubeId, timecode, compact, longDate } from '../util.js';
import { PATHS, TOPICS } from '../config.js';
import { hasToken, updateJSON, verifyToken, rateLimit } from '../github.js';
import { store, loadCatalog, getChannel, getSeries, videosOfChannel } from '../store.js';
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
  const tab = TABS.some((t) => t.id === query.tab) ? query.tab : 'videos';

  const nodes = [
    el('div', { class: 'page-head' },
      el('h1', { class: 'page-title' }, 'Studio'),
      el('p', { class: 'page-sub' }, 'Manage the catalog. Changes are committed to the repo.')),
    tokenBanner(),
    tabs(TABS, tab, (id) => navigate('/studio', { tab: id })),
  ];

  const panels = { videos: videosPanel, channels: channelsPanel, series: seriesPanel, playlists: playlistsPanel };
  nodes.push(panels[tab]());

  setView(nodes, { title: 'Studio' });
}

const rerender = () => studioView({ query: currentQuery() });

function currentQuery() {
  const qs = location.hash.split('?')[1] || '';
  return Object.fromEntries(new URLSearchParams(qs));
}

/* ---------- token banner ---------- */

function tokenBanner() {
  if (hasToken()) {
    const banner = el('div', { class: 'banner' },
      svgIcon('check', 20),
      el('div', { style: { flex: '1' } },
        el('div', { class: 'banner-title' }, 'Connected to GitHub'),
        el('div', { class: 'muted' }, 'Saving publishes a commit to the repo.')),
      button('Check access', {
        variant: 'ghost',
        onClick: async () => {
          const result = await verifyToken();
          if (!result.ok) { toast(result.reason, { duration: 6000 }); return; }
          const limit = await rateLimit();
          toast(`Write access to ${result.repo}${limit ? ` · ${limit.remaining} API calls left this hour` : ''}`,
            { duration: 5000 });
        },
      }));
    return banner;
  }

  return el('div', { class: 'banner banner-warn' },
    svgIcon('settings', 20),
    el('div', { style: { flex: '1' } },
      el('div', { class: 'banner-title' }, 'Read-only — no GitHub token'),
      el('div', { class: 'muted' },
        'You can browse the catalog here, but saving needs a token with Contents: Read and write on this repo.')),
    button('Add token', { variant: 'primary', onClick: () => navigate('/settings') }));
}

/* ---------- generic save helper ---------- */

/**
 * Apply `mutate` to one of the catalog files, then refresh the in-memory copy.
 * `mutate(list)` receives the array under `key` and returns the new array.
 */
async function saveCatalogFile(path, key, mutate, message) {
  if (!hasToken()) {
    toast('Add a GitHub token in Settings before saving.', { duration: 5000 });
    return false;
  }
  const pending = toast('Saving…', { duration: 30000 });
  try {
    await updateJSON(path, (data) => {
      const list = Array.isArray(data?.[key]) ? data[key] : [];
      return { ...(data || {}), [key]: mutate(list) };
    }, { message, fallback: { [key]: [] } });

    await loadCatalog({ fresh: true });
    pending.remove();
    toast('Saved and published');
    return true;
  } catch (err) {
    pending.remove();
    toast(`Save failed: ${err.message}`, { duration: 8000 });
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

/** Multi-select topic chips backed by a Set. */
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
        iconButton('trash', 'Delete', () => removeVideo(v), { size: 18 }))));
  });

  return el('div', {},
    el('div', { class: 'section-head', style: { marginTop: '0' } },
      el('h2', { class: 'section-title' }, `${videos.length} ${videos.length === 1 ? 'video' : 'videos'}`),
      button('Add video', { variant: 'primary', icon: 'plus', onClick: () => openVideoForm(null) })),
    videos.length
      ? table(['Title', 'Channel', 'Source', 'Length', 'Views', 'Published', ''], rows)
      : emptyState('film', 'No videos yet', 'Add your first documentary to get the catalog started.',
          button('Add video', { variant: 'primary', onClick: () => openVideoForm(null) })));
}

function openVideoForm(existing) {
  const isNew = !existing;
  const v = existing || {};
  const src = v.source || { type: 'youtube' };

  const channels = store.catalog.channels;
  if (!channels.length) {
    modal({
      title: 'Add a channel first',
      body: el('p', {}, 'Every video belongs to a channel. Create one on the Channels tab, then come back.'),
      actions: [{ label: 'Go to Channels', variant: 'primary', onClick: () => navigate('/studio', { tab: 'channels' }) }],
    });
    return;
  }

  const title = textInput(v.title, { placeholder: 'Planet Earth II: Islands', maxlength: '200' });
  const sourceType = selectInput([['youtube', 'YouTube video'], ['file', 'Hosted file (MP4/HLS)']], src.type);
  const youtubeId = textInput(src.youtubeId, { placeholder: 'Paste a YouTube URL or 11-character id' });
  const fileSrc = textInput(src.src, { placeholder: 'https://cdn.example.com/film.mp4' });
  const poster = textInput(src.poster, { placeholder: 'https://…/poster.jpg' });
  const thumbnail = textInput(v.thumbnail, { placeholder: 'Leave blank to use the YouTube thumbnail' });
  const channelId = selectInput(channels.map((c) => [c.id, c.name]), v.channelId || channels[0].id);
  const description = textArea(v.description, { placeholder: 'What is this documentary about?', maxlength: '5000' });
  const duration = textInput(v.durationSec ? timecode(v.durationSec) : '', { placeholder: '1:02:33 or seconds' });
  const published = textInput(v.publishedAt ? String(v.publishedAt).slice(0, 10) : new Date().toISOString().slice(0, 10), { type: 'date' });
  const year = textInput(v.year || '', { type: 'number', min: '1888', max: '2100', placeholder: '2016' });
  const rating = textInput(v.rating, { placeholder: 'TV-PG', maxlength: '12' });
  const views = textInput(v.views ?? 0, { type: 'number', min: '0' });
  const seriesId = selectInput(
    [['', 'Not part of a series'], ...store.catalog.series.map((s) => [s.id, s.title])], v.seriesId || '');
  const season = textInput(v.season || '', { type: 'number', min: '1', placeholder: '1' });
  const episode = textInput(v.episode || '', { type: 'number', min: '1', placeholder: '1' });
  const topics = topicPicker(v.topics || []);
  const errorBox = el('div', { class: 'form-error', hidden: true });

  const youtubeRow = field('YouTube URL or id', youtubeId, 'Accepts youtu.be, /watch?v=, /embed/ and /shorts/ links.');
  const fileRow = field('Video file URL', fileSrc, 'Must be a direct, CORS-enabled MP4/WebM or HLS URL.');
  const posterRow = field('Poster image', poster, 'Shown before playback starts.');

  const syncSourceRows = () => {
    const yt = sourceType.value === 'youtube';
    youtubeRow.hidden = !yt;
    fileRow.hidden = yt;
    posterRow.hidden = yt;
  };
  sourceType.addEventListener('change', syncSourceRows);
  syncSourceRows();

  const body = el('div', { class: 'form-grid' },
    errorBox,
    field('Title', title),
    field('Channel', channelId),
    field('Source', sourceType),
    youtubeRow, fileRow, posterRow,
    field('Custom thumbnail', thumbnail),
    field('Description', description),
    el('div', { class: 'form-row-2' }, field('Duration', duration), field('Published', published)),
    el('div', { class: 'form-row-2' }, field('Year', year), field('Rating', rating)),
    field('Starting view count', views, 'A baseline number; real plays are counted on top of it.'),
    field('Series', seriesId),
    el('div', { class: 'form-row-2' }, field('Season', season), field('Episode', episode)),
    field('Topics', topics));

  modal({
    title: isNew ? 'Add video' : 'Edit video',
    wide: true,
    body,
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
            id: v.id || `v_${slugify(name) || uid('vid')}`,
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

          saveCatalogFile(PATHS.videos, 'videos', (list) => {
            const i = list.findIndex((x) => x.id === record.id);
            if (i >= 0) { const next = list.slice(); next[i] = record; return next; }
            return [record, ...list];
          }, `${isNew ? 'Add' : 'Update'} video: ${name}`).then((ok) => { if (ok) rerender(); });
        },
      },
    ],
  });
}

async function removeVideo(video) {
  const ok = await confirmDialog('Delete this video?',
    `“${video.title}” will be removed from the catalog. Viewers’ history entries for it will stop resolving.`);
  if (!ok) return;
  const saved = await saveCatalogFile(PATHS.videos, 'videos',
    (list) => list.filter((x) => x.id !== video.id),
    `Remove video: ${video.title}`);
  if (saved) rerender();
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
      iconButton('trash', 'Delete', () => removeChannel(c), { size: 18 }))));

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

  // Auto-fill the handle from the name while it's untouched.
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

          saveCatalogFile(PATHS.channels, 'channels', (list) => {
            const i = list.findIndex((x) => x.id === record.id);
            if (i >= 0) { const next = list.slice(); next[i] = record; return next; }
            return [...list, record];
          }, `${isNew ? 'Add' : 'Update'} channel: ${channelName}`).then((ok) => { if (ok) rerender(); });
        },
      },
    ],
  });
}

async function removeChannel(channel) {
  const count = videosOfChannel(channel.id).length;
  const ok = await confirmDialog('Delete this channel?',
    count
      ? `${channel.name} still has ${count} ${count === 1 ? 'video' : 'videos'}. They'll stay in the catalog but show as "unknown channel". Delete anyway?`
      : `${channel.name} will be removed.`);
  if (!ok) return;
  const saved = await saveCatalogFile(PATHS.channels, 'channels',
    (list) => list.filter((x) => x.id !== channel.id),
    `Remove channel: ${channel.name}`);
  if (saved) rerender();
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
        iconButton('trash', 'Delete', () => removeSeries(s), { size: 18 }))));
  });

  return el('div', {},
    el('div', { class: 'section-head', style: { marginTop: '0' } },
      el('h2', { class: 'section-title' }, `${store.catalog.series.length} series`),
      button('Add series', { variant: 'primary', icon: 'plus', onClick: () => openSeriesForm(null) })),
    el('div', { class: 'banner' },
      svgIcon('film', 20),
      el('div', {}, 'Assign episodes to a series from the video form — set Series, Season and Episode there.')),
    store.catalog.series.length
      ? table(['Series', 'Channel', 'Episodes', 'Seasons', ''], rows)
      : emptyState('film', 'No series yet', 'Group multi-part documentaries into a docuseries.',
          button('Add series', { variant: 'primary', onClick: () => openSeriesForm(null) })));
}

function openSeriesForm(existing) {
  const isNew = !existing;
  const s = existing || {};
  const channels = store.catalog.channels;

  if (!channels.length) {
    modal({
      title: 'Add a channel first',
      body: el('p', {}, 'A series belongs to a channel. Create one on the Channels tab first.'),
      actions: [{ label: 'Go to Channels', variant: 'primary', onClick: () => navigate('/studio', { tab: 'channels' }) }],
    });
    return;
  }

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
            id: s.id || `s_${slugify(name) || uid('ser')}`,
            title: name,
            channelId: channelId.value,
            description: description.value.trim(),
            poster: poster.value.trim() || null,
            backdrop: backdrop.value.trim() || null,
            topics: topics.getValue(),
            // Seasons are derived from each video's season/episode fields unless
            // an explicit ordering was already stored.
            ...(s.seasons ? { seasons: s.seasons } : {}),
          };

          saveCatalogFile(PATHS.series, 'series', (list) => {
            const i = list.findIndex((x) => x.id === record.id);
            if (i >= 0) { const next = list.slice(); next[i] = record; return next; }
            return [...list, record];
          }, `${isNew ? 'Add' : 'Update'} series: ${name}`).then((ok) => { if (ok) rerender(); });
        },
      },
    ],
  });
}

async function removeSeries(series) {
  const episodes = store.catalog.videos.filter((v) => v.seriesId === series.id);
  const ok = await confirmDialog('Delete this series?',
    episodes.length
      ? `${episodes.length} ${episodes.length === 1 ? 'episode stays' : 'episodes stay'} in the catalog as standalone titles.`
      : `“${series.title}” will be removed.`);
  if (!ok) return;
  const saved = await saveCatalogFile(PATHS.series, 'series',
    (list) => list.filter((x) => x.id !== series.id),
    `Remove series: ${series.title}`);
  if (saved) rerender();
}

/* ---------- curated playlists ---------- */

function playlistsPanel() {
  const rows = store.catalog.playlists.map((p) => el('tr', {},
    el('td', {}, el('a', { href: href(`/playlist/${p.id}`), style: { fontWeight: '600' } }, p.title)),
    el('td', {}, getChannel(p.channelId)?.name || '—'),
    el('td', {}, String((p.videoIds || []).length)),
    el('td', {}, el('div', { class: 'row-actions' },
      iconButton('settings', 'Edit', () => openCuratedPlaylistForm(p), { size: 18 }),
      iconButton('trash', 'Delete', () => removeCuratedPlaylist(p), { size: 18 }))));

  return el('div', {},
    el('div', { class: 'section-head', style: { marginTop: '0' } },
      el('h2', { class: 'section-title' }, `${store.catalog.playlists.length} published playlists`),
      button('Add playlist', { variant: 'primary', icon: 'plus', onClick: () => openCuratedPlaylistForm(null) })),
    el('div', { class: 'banner' },
      svgIcon('library', 20),
      el('div', {}, 'These are published for everyone. Playlists a viewer makes for themselves live in their own profile.')),
    store.catalog.playlists.length
      ? table(['Playlist', 'Channel', 'Titles', ''], rows)
      : emptyState('library', 'No published playlists', 'Curate a collection that everyone sees.',
          button('Add playlist', { variant: 'primary', onClick: () => openCuratedPlaylistForm(null) })));
}

function openCuratedPlaylistForm(existing) {
  const isNew = !existing;
  const p = existing || {};
  const chosen = new Set(p.videoIds || []);

  const title = textInput(p.title, { placeholder: 'Best of the ocean', maxlength: '120' });
  const description = textArea(p.description, { maxlength: '1000' });
  const channelId = selectInput(
    [['', 'No channel'], ...store.catalog.channels.map((c) => [c.id, c.name])], p.channelId || '');

  const picker = el('div', { class: 'picker-list' },
    ...store.catalog.videos.map((v) => el('label', { class: 'picker-row' },
      el('input', {
        type: 'checkbox',
        checked: chosen.has(v.id) || null,
        onchange: (e) => { if (e.target.checked) chosen.add(v.id); else chosen.delete(v.id); },
      }),
      el('span', { class: 'picker-name' }, v.title),
      el('span', { class: 'picker-count' }, timecode(v.durationSec)))));

  const errorBox = el('div', { class: 'form-error', hidden: true });

  modal({
    title: isNew ? 'Add playlist' : 'Edit playlist',
    wide: true,
    body: el('div', { class: 'form-grid' },
      errorBox,
      field('Title', title),
      field('Description', description),
      field('Channel', channelId),
      field('Titles', picker, 'Order follows the catalog. Reorder by editing data/playlists.json directly.')),
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
            id: p.id || `pl_${slugify(name) || uid('pl')}`,
            title: name,
            description: description.value.trim(),
            channelId: channelId.value || null,
            videoIds: [...chosen],
            visibility: 'public',
          };

          saveCatalogFile(PATHS.playlists, 'playlists', (list) => {
            const i = list.findIndex((x) => x.id === record.id);
            if (i >= 0) { const next = list.slice(); next[i] = record; return next; }
            return [...list, record];
          }, `${isNew ? 'Add' : 'Update'} playlist: ${name}`).then((ok) => { if (ok) rerender(); });
        },
      },
    ],
  });
}

async function removeCuratedPlaylist(playlist) {
  const ok = await confirmDialog('Delete this playlist?',
    `“${playlist.title}” will be unpublished. The videos stay in the catalog.`);
  if (!ok) return;
  const saved = await saveCatalogFile(PATHS.playlists, 'playlists',
    (list) => list.filter((x) => x.id !== playlist.id),
    `Remove playlist: ${playlist.title}`);
  if (saved) rerender();
}

export { getSeries };
