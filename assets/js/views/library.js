// Subscriptions, History, Liked, Watch later, and the viewer's playlists.

import { el } from '../util.js';
import {
  store, subscriptionFeed, historyVideos, likedVideos, watchLaterVideos,
  clearHistory, getChannel, createPlaylist,
} from '../store.js';
import {
  videoCard, playlistCard, grid, emptyState, button, sectionTitle,
  confirmDialog, toast, modal, skeletonGrid,
} from '../components.js';
import { navigate, href } from '../router.js';
import { setView } from '../app.js';

const SECTIONS = {
  subscriptions: {
    title: 'Subscriptions',
    empty: ['subs', 'No subscriptions yet', 'Subscribe to a channel and its newest titles land here.'],
  },
  history: {
    title: 'Watch history',
    empty: ['history', 'Nothing watched yet', 'Videos you play show up here so you can pick up where you left off.'],
  },
  liked: {
    title: 'Liked videos',
    empty: ['like', 'No liked videos', 'Tap like on anything you enjoy and it collects here.'],
  },
  watchLater: {
    title: 'Watch later',
    empty: ['clock', 'Watch later is empty', 'Save titles from any card’s ⋮ menu to build a queue.'],
  },
  playlists: {
    title: 'Your playlists',
    empty: ['library', 'No playlists yet', 'Group titles into playlists to line up a marathon.'],
  },
};

export default function libraryView({ section = 'history' } = {}) {
  const config = SECTIONS[section] || SECTIONS.history;

  if (!store.ready && !store.catalog.videos.length) {
    setView(skeletonGrid(8), { title: config.title });
    return;
  }

  const builders = {
    subscriptions: subscriptionsSection,
    history: historySection,
    liked: likedSection,
    watchLater: watchLaterSection,
    playlists: playlistsSection,
  };

  setView(builders[section](config), { title: config.title });
}

function head(title, actions = null, sub = null) {
  return el('div', { class: 'section-head', style: { marginTop: 0 } },
    el('div', {},
      el('h1', { class: 'page-title' }, title),
      sub ? el('p', { class: 'page-sub' }, sub) : null),
    actions ? el('div', { class: 'section-actions' }, actions) : null);
}

function empty(config) {
  const [icon, title, body] = config.empty;
  return emptyState(icon, title, body,
    button('Browse the catalog', { variant: 'primary', onClick: () => navigate('/') }));
}

/* ---------- sections ---------- */

function subscriptionsSection(config) {
  const channels = store.user.subscriptions.map(getChannel).filter(Boolean);
  const videos = subscriptionFeed();

  if (!channels.length) return [head(config.title), empty(config)];

  return [
    head(config.title, null, `${channels.length} ${channels.length === 1 ? 'channel' : 'channels'}`),
    el('div', { class: 'chipbar', style: { position: 'static' } },
      ...channels.map((c) => el('a', {
        class: 'chip', href: href(`/channel/${c.handle || c.id}`),
      }, c.name))),
    videos.length
      ? grid(videos.map((v) => videoCard(v)))
      : emptyState('film', 'Nothing new',
          'Your subscriptions haven’t published anything in the catalog yet.'),
  ];
}

function historySection(config) {
  const videos = historyVideos();
  if (!videos.length) return [head(config.title), empty(config)];

  const rerender = () => libraryView({ section: 'history' });

  return [
    head(config.title,
      button('Clear all history', {
        variant: 'subtle', icon: 'trash',
        onClick: async () => {
          const ok = await confirmDialog('Clear watch history?',
            'This removes every entry and all resume positions on this device. It can’t be undone.',
            { confirmLabel: 'Clear history' });
          if (!ok) return;
          clearHistory();
          toast('Watch history cleared');
          rerender();
        },
      }),
      `${videos.length} ${videos.length === 1 ? 'title' : 'titles'}`),
    // The card draws its own resume bar from the stored progress.
    grid(videos.map((v) => videoCard(v, { layout: 'row', showDescription: true, onRemove: rerender })),
      { className: 'results-list' }),
  ];
}

function likedSection(config) {
  const videos = likedVideos();
  if (!videos.length) return [head(config.title), empty(config)];
  return [
    head(config.title, null, `${videos.length} ${videos.length === 1 ? 'title' : 'titles'}`),
    grid(videos.map((v) => videoCard(v))),
  ];
}

function watchLaterSection(config) {
  const videos = watchLaterVideos();
  if (!videos.length) return [head(config.title), empty(config)];

  const rerender = () => libraryView({ section: 'watchLater' });

  return [
    head(config.title,
      button('Play all', {
        variant: 'primary',
        onClick: () => navigate('/watch', { v: videos[0].id }),
      }),
      `${videos.length} ${videos.length === 1 ? 'title' : 'titles'}`),
    grid(videos.map((v, i) => videoCard(v, { layout: 'row', index: i + 1, onRemove: rerender })),
      { className: 'results-list' }),
  ];
}

function playlistsSection(config) {
  const mine = store.user.playlists;
  const curated = store.catalog.playlists;

  const newPlaylist = button('New playlist', {
    variant: 'primary', icon: 'plus',
    onClick: () => {
      const input = el('input', { class: 'input', placeholder: 'Playlist name', maxlength: '100' });
      const visibility = el('select', { class: 'select' },
        el('option', { value: 'private' }, 'Private'),
        el('option', { value: 'public' }, 'Public'));
      modal({
        title: 'New playlist',
        body: el('div', { class: 'form-grid' },
          el('div', { class: 'form-row' }, el('label', { class: 'form-label' }, 'Name'), input),
          el('div', { class: 'form-row' }, el('label', { class: 'form-label' }, 'Visibility'), visibility)),
        actions: [
          { label: 'Cancel', variant: 'ghost' },
          {
            label: 'Create',
            variant: 'primary',
            onClick: () => {
              const title = input.value.trim();
              if (!title) { input.focus(); return false; }
              const pl = createPlaylist(title, { visibility: visibility.value });
              toast(`Created “${pl.title}”`);
              navigate(`/playlist/${pl.id}`);
            },
          },
        ],
      });
    },
  });

  if (!mine.length && !curated.length) {
    return [head(config.title, newPlaylist), empty(config)];
  }

  const nodes = [head(config.title, newPlaylist)];
  if (mine.length) {
    nodes.push(sectionTitle('Created by you'), grid(mine.map((p) => playlistCard(p, { owned: true }))));
  }
  if (curated.length) {
    nodes.push(sectionTitle('From channels'), grid(curated.map((p) => playlistCard(p))));
  }
  return nodes;
}
