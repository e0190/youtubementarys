// Channel page: banner, header, and Home / Videos / Series / Playlists / About tabs.

import { el, compact, longDate } from '../util.js';
import {
  store, getChannel, videosOfChannel, seriesOfChannel, viewsOf,
} from '../store.js';
import {
  videoCard, seriesCard, playlistCard, grid, shelf, tabs, avatar, subscribeButton,
  svgIcon, emptyState, button, sectionTitle,
} from '../components.js';
import { href, navigate } from '../router.js';
import { setView } from '../app.js';

const TABS = [
  { id: 'home', label: 'Home' },
  { id: 'videos', label: 'Videos' },
  { id: 'series', label: 'Series' },
  { id: 'playlists', label: 'Playlists' },
  { id: 'about', label: 'About' },
];

export default function channelView({ params, query = {} }) {
  const channel = getChannel(params.handle);

  if (!channel) {
    if (!store.ready) { setView(el('div', { class: 'skel', style: { height: '240px' } })); return; }
    setView(emptyState('subs', 'Channel not found',
      'No channel matches that handle. It may have been renamed or removed.',
      button('Back to home', { variant: 'primary', onClick: () => navigate('/') })),
      { title: 'Channel not found' });
    return;
  }

  const activeTab = TABS.some((t) => t.id === query.tab) ? query.tab : 'home';
  const videos = videosOfChannel(channel.id);
  const series = seriesOfChannel(channel.id);
  const playlists = store.catalog.playlists.filter((p) => p.channelId === channel.id);

  const nodes = [
    channel.banner
      ? el('div', { class: 'channel-banner' }, el('img', { src: channel.banner, alt: '' }))
      : null,

    el('div', { class: 'channel-header' },
      avatar(channel, 112),
      el('div', { class: 'channel-header-text' },
        el('h1', { class: 'channel-name' },
          channel.name,
          channel.verified ? el('span', { class: 'verified' }, svgIcon('check', 16)) : null),
        el('div', { class: 'channel-stats' },
          [channel.handle ? `@${channel.handle}` : null,
           `${compact(channel.subscribers || 0)} subscribers`,
           `${videos.length} ${videos.length === 1 ? 'video' : 'videos'}`].filter(Boolean).join(' · ')),
        channel.tagline ? el('p', { class: 'channel-tagline' }, channel.tagline) : null),
      subscribeButton(channel.id)),

    tabs(TABS, activeTab, (tab) => navigate(`/channel/${params.handle}`, tab === 'home' ? {} : { tab })),
  ];

  const panels = {
    home: () => homeTab(channel, videos, series, playlists),
    videos: () => videosTab(videos, query),
    series: () => (series.length
      ? el('div', { class: 'series-grid' }, ...series.map(seriesCard))
      : emptyState('film', 'No series yet', `${channel.name} hasn’t published a docuseries.`)),
    playlists: () => (playlists.length
      ? grid(playlists.map((p) => playlistCard(p)))
      : emptyState('library', 'No playlists yet', `${channel.name} hasn’t published any playlists.`)),
    about: () => aboutTab(channel, videos),
  };

  nodes.push(panels[activeTab]());
  setView(nodes, { title: channel.name });
}

function homeTab(channel, videos, series, playlists) {
  if (!videos.length && !series.length) {
    return emptyState('film', 'Nothing here yet', `${channel.name} hasn’t published anything.`);
  }

  const featured = videos[0];
  const nodes = [];

  if (featured) {
    nodes.push(shelf('Latest', videos.slice(0, 12).map((v) => videoCard(v, { showChannel: false })),
      { link: href(`/channel/${channel.handle || channel.id}`, { tab: 'videos' }) }));
  }
  if (series.length) {
    nodes.push(shelf('Series', series.map(seriesCard),
      { link: href(`/channel/${channel.handle || channel.id}`, { tab: 'series' }) }));
  }

  const popular = videos.slice().sort((a, b) => viewsOf(b) - viewsOf(a)).slice(0, 12);
  if (popular.length) {
    nodes.push(shelf('Most watched', popular.map((v) => videoCard(v, { showChannel: false }))));
  }
  if (playlists.length) {
    nodes.push(shelf('Playlists', playlists.map((p) => playlistCard(p))));
  }
  return nodes;
}

function videosTab(videos, query) {
  if (!videos.length) return emptyState('film', 'No videos yet', 'Nothing has been published here.');

  const sort = query.sort || 'newest';
  const sorted = videos.slice().sort(
    sort === 'popular' ? (a, b) => viewsOf(b) - viewsOf(a)
    : sort === 'oldest' ? (a, b) => new Date(a.publishedAt || 0) - new Date(b.publishedAt || 0)
    : (a, b) => new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0));

  const setSort = (next) => {
    const url = new URLSearchParams(location.hash.split('?')[1] || '');
    url.set('sort', next);
    location.hash = `${location.hash.split('?')[0]}?${url}`;
  };

  return [
    el('div', { class: 'section-head' },
      el('div', { class: 'section-actions' },
        ...[['newest', 'Latest'], ['popular', 'Popular'], ['oldest', 'Oldest']].map(([id, label]) =>
          el('button', { class: `chip${sort === id ? ' is-active' : ''}`, onclick: () => setSort(id) }, label)))),
    grid(sorted.map((v) => videoCard(v, { showChannel: false }))),
  ];
}

function aboutTab(channel, videos) {
  const totalViews = videos.reduce((sum, v) => sum + viewsOf(v), 0);
  return el('div', { class: 'about-grid' },
    el('div', {},
      sectionTitle('Description'),
      el('p', { style: { whiteSpace: 'pre-wrap', color: 'var(--text-muted)' } },
        channel.description || channel.tagline || 'No description provided.'),
      channel.links?.length
        ? el('div', {},
            sectionTitle('Links'),
            el('div', { class: 'channel-links' },
              ...channel.links.map((l) => el('a', {
                href: l.url, target: '_blank', rel: 'noopener noreferrer',
              }, l.label || l.url))))
        : null),
    el('div', {},
      sectionTitle('Stats'),
      el('dl', { class: 'about-stats' },
        el('dt', {}, 'Joined'), el('dd', {}, channel.joined ? longDate(channel.joined) : '—'),
        el('dt', {}, 'Subscribers'), el('dd', {}, compact(channel.subscribers || 0)),
        el('dt', {}, 'Videos'), el('dd', {}, String(videos.length)),
        el('dt', {}, 'Total views'), el('dd', {}, compact(totalViews)),
        el('dt', {}, 'Topics'), el('dd', {}, (channel.topics || []).join(', ') || '—'))));
}
