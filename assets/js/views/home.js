// Home feed and Explore.

import { el } from '../util.js';
import { TOPICS } from '../config.js';
import {
  store, homeFeed, continueWatching, subscriptionFeed, seriesOfChannel, getChannel,
} from '../store.js';
import {
  videoCard, seriesCard, channelCard, grid, shelf, chipBar, skeletonGrid,
  emptyState, sectionTitle, button,
} from '../components.js';
import { href, navigate } from '../router.js';
import { setView } from '../app.js';

export default function homeView({ query = {}, explore = false } = {}) {
  if (!store.ready && !store.catalog.videos.length) {
    setView([
      el('div', { class: 'chipbar' }),
      skeletonGrid(12),
    ], { title: explore ? 'Explore' : null });
    return;
  }

  const topic = query.topic || null;
  const nodes = [];

  nodes.push(chipBar(TOPICS, topic || 'All', (next) => {
    navigate(explore ? '/explore' : '/', next ? { topic: next } : {});
  }));

  if (!store.catalog.videos.length) {
    setView([
      ...nodes,
      emptyState('film', 'No titles yet',
        'The catalog is empty. Add your first documentary in Studio and it will show up here.',
        button('Open Studio', { variant: 'primary', onClick: () => navigate('/studio') })),
    ], { title: 'Home' });
    return;
  }

  if (explore) {
    nodes.push(...exploreSections(topic));
  } else {
    nodes.push(...homeSections(topic));
  }

  setView(nodes, { title: explore ? 'Explore' : null });
}

function homeSections(topic) {
  const nodes = [];

  if (!topic) {
    const resume = continueWatching(10);
    if (resume.length) {
      nodes.push(shelf('Continue watching',
        resume.map((v) => videoCard(v, { layout: 'grid' })),
        { link: href('/history'), linkLabel: 'History' }));
    }

    const fromSubs = subscriptionFeed().slice(0, 10);
    if (fromSubs.length) {
      nodes.push(shelf('New from your subscriptions',
        fromSubs.map((v) => videoCard(v)),
        { link: href('/subscriptions'), linkLabel: 'See all' }));
    }

    const featured = store.catalog.series.slice(0, 10);
    if (featured.length) {
      nodes.push(shelf('Docuseries', featured.map(seriesCard)));
    }
  }

  const feed = homeFeed(topic);
  nodes.push(
    sectionTitle(topic ? topic : 'Recommended'),
    feed.length
      ? grid(feed.map((v) => videoCard(v)))
      : emptyState('compass', `Nothing in ${topic} yet`,
          'Try another topic, or add titles tagged with this one in Studio.'));

  return nodes;
}

function exploreSections(topic) {
  const nodes = [];
  const topicsToShow = topic ? [topic] : TOPICS;

  if (!topic) {
    const channels = store.catalog.channels
      .slice()
      .sort((a, b) => (b.subscribers || 0) - (a.subscribers || 0))
      .slice(0, 12);
    if (channels.length) {
      nodes.push(sectionTitle('Channels'));
      nodes.push(el('div', { class: 'channel-grid' },
        ...channels.map((c) => el('div', { class: 'channel-tile' },
          el('a', { href: href(`/channel/${c.handle || c.id}`), 'aria-label': c.name },
            channelCard(c, { compactMode: true }))))));
    }

    if (store.catalog.series.length) {
      nodes.push(sectionTitle('All docuseries'));
      nodes.push(el('div', { class: 'series-grid' }, ...store.catalog.series.map(seriesCard)));
    }
  }

  for (const t of topicsToShow) {
    const items = store.catalog.videos.filter((v) => (v.topics || []).includes(t));
    if (!items.length) continue;
    nodes.push(shelf(t,
      items.slice(0, 12).map((v) => videoCard(v)),
      { link: href('/results', { q: t }), linkLabel: 'See all' }));
  }

  if (!nodes.length) {
    nodes.push(emptyState('compass', 'Nothing to explore yet',
      'Once the catalog has a few titles, they’ll be grouped by topic here.'));
  }
  return nodes;
}

/** Channel shelves used by the "Home" tab of a channel page. */
export function channelHomeShelves(channel) {
  const nodes = [];
  const series = seriesOfChannel(channel.id);
  if (series.length) {
    nodes.push(shelf('Series', series.map(seriesCard)));
  }
  const related = store.catalog.channels
    .filter((c) => c.id !== channel.id && (c.topics || []).some((t) => (channel.topics || []).includes(t)))
    .slice(0, 8);
  if (related.length) {
    nodes.push(shelf('Related channels', related.map((c) => channelCard(c, { compactMode: true }))));
  }
  return nodes;
}

export { getChannel };
