// Search results with filters, plus matching channels and series.

import { el } from '../util.js';
import { TOPICS } from '../config.js';
import { store, searchVideos, searchChannels, searchSeries } from '../store.js';
import {
  videoCard, channelCard, seriesCard, grid, emptyState, button, skeletonGrid, shelf,
} from '../components.js';
import { navigate } from '../router.js';
import { setView } from '../app.js';

const FILTERS = [
  {
    key: 'sort', label: 'Sort by', options: [
      ['relevance', 'Relevance'], ['newest', 'Upload date'],
      ['views', 'View count'], ['rating', 'Rating'],
    ],
  },
  { key: 'type', label: 'Type', options: [['', 'Any'], ['film', 'Single film'], ['series', 'Series episode']] },
  { key: 'len', label: 'Length', options: [['', 'Any'], ['short', 'Under 20 min'], ['medium', '20–60 min'], ['long', 'Over 1 hour']] },
];

export default function searchView({ query = {} }) {
  const q = (query.q || '').trim();

  if (!store.ready && !store.catalog.videos.length) {
    setView(skeletonGrid(8, 'row'), { title: q ? `${q} — search` : 'Search' });
    return;
  }

  const opts = {
    sort: query.sort || 'relevance',
    topic: query.topic || null,
    type: query.type || null,
    length: query.len || null,
  };

  const videos = searchVideos(q, opts);
  const channels = q ? searchChannels(q) : [];
  const series = q ? searchSeries(q) : [];

  const setParam = (key, value) => {
    const next = { ...query };
    if (value) next[key] = value; else delete next[key];
    navigate('/results', next);
  };

  const nodes = [
    el('div', { class: 'page-head' },
      el('h1', { class: 'page-title' }, q ? `Results for “${q}”` : 'Browse everything'),
      el('p', { class: 'page-sub' },
        `${videos.length} ${videos.length === 1 ? 'title' : 'titles'}`
        + (channels.length ? ` · ${channels.length} channels` : '')
        + (series.length ? ` · ${series.length} series` : ''))),

    el('div', { class: 'section-head', style: { flexWrap: 'wrap', gap: '.75rem', marginTop: 0 } },
      el('div', { class: 'section-actions', style: { flexWrap: 'wrap' } },
        ...FILTERS.map((f) => el('select', {
          class: 'select',
          style: { width: 'auto' },
          'aria-label': f.label,
          onchange: (e) => setParam(f.key === 'len' ? 'len' : f.key, e.target.value),
        }, ...f.options.map(([value, label]) => el('option', {
          value,
          selected: (query[f.key] || (f.key === 'sort' ? 'relevance' : '')) === value || null,
        }, f.key === 'sort' ? label : `${f.label}: ${label}`)))),

        el('select', {
          class: 'select', style: { width: 'auto' }, 'aria-label': 'Topic',
          onchange: (e) => setParam('topic', e.target.value),
        },
          el('option', { value: '', selected: !query.topic || null }, 'Topic: Any'),
          ...TOPICS.map((t) => el('option', { value: t, selected: query.topic === t || null }, t))),

        Object.keys(query).some((k) => k !== 'q')
          ? button('Clear filters', { variant: 'ghost', onClick: () => navigate('/results', q ? { q } : {}) })
          : null)),
  ];

  if (channels.length) {
    nodes.push(el('section', { style: { marginBottom: '1.5rem' } },
      ...channels.slice(0, 3).map((c) => channelCard(c))));
  }

  if (series.length) {
    nodes.push(shelf('Series', series.map(seriesCard)));
  }

  if (videos.length) {
    nodes.push(grid(videos.map((v) => videoCard(v, { layout: 'row', showDescription: true })),
      { className: 'results-list' }));
  } else if (!channels.length && !series.length) {
    nodes.push(emptyState('search', 'No results',
      q ? `Nothing matches “${q}”. Try fewer words, or a different topic.`
        : 'The catalog is empty — add titles in Studio.',
      button('Clear search', { variant: 'primary', onClick: () => navigate('/') })));
  }

  setView(nodes, { title: q ? `${q} — search` : 'Search' });
}
