// Docuseries page: hero, seasons, episode list with resume state.

import { el, compact, timecode, durationWords, longDate } from '../util.js';
import {
  store, getSeries, getChannel, videosOfSeries, seasonsOf, viewsOf,
  resumePosition, progressRatio, historyEntry, thumbnailFor, thumbnailFallback,
} from '../store.js';
import {
  avatar, subscribeButton, button, emptyState, svgIcon, tabs,
} from '../components.js';
import { href, navigate } from '../router.js';
import { setView } from '../app.js';

export default function seriesView({ params, query = {} }) {
  const series = getSeries(params.id);

  if (!series) {
    if (!store.ready) { setView(el('div', { class: 'skel', style: { height: '280px' } })); return; }
    setView(emptyState('film', 'Series not found',
      'This docuseries isn’t in the catalog.',
      button('Back to home', { variant: 'primary', onClick: () => navigate('/') })),
      { title: 'Series not found' });
    return;
  }

  const channel = getChannel(series.channelId);
  const seasons = seasonsOf(series.id);
  const allEpisodes = videosOfSeries(series.id);

  if (!allEpisodes.length) {
    setView([
      hero(series, channel, null, allEpisodes),
      emptyState('film', 'No episodes yet', 'Episodes added to this series will appear here.'),
    ], { title: series.title });
    return;
  }

  // Resume at the first unfinished episode, else the first one.
  const resumeTarget = allEpisodes.find((ep) => {
    const entry = historyEntry(ep.id);
    return !entry || !entry.completed;
  }) || allEpisodes[0];

  const activeSeason = seasons.find((s) => String(s.number) === query.season) || seasons[0];

  const nodes = [hero(series, channel, resumeTarget, allEpisodes)];

  if (seasons.length > 1) {
    nodes.push(tabs(
      seasons.map((s) => ({ id: String(s.number), label: s.title })),
      String(activeSeason.number),
      (id) => navigate(`/series/${series.id}`, { season: id })));
  }

  nodes.push(el('section', { class: 'season-block' },
    el('div', { class: 'section-head' },
      el('h2', { class: 'section-title' }, activeSeason.title),
      el('div', { class: 'card-meta' }, `${activeSeason.episodes.length} episodes`)),
    el('div', { class: 'episode-list' },
      ...activeSeason.episodes.map((ep, i) => episodeRow(ep, i + 1)))));

  setView(nodes, { title: series.title });
}

function hero(series, channel, resumeTarget, episodes) {
  const totalSeconds = episodes.reduce((sum, e) => sum + (e.durationSec || 0), 0);
  const totalViews = episodes.reduce((sum, e) => sum + viewsOf(e), 0);
  const years = episodes.map((e) => e.year || new Date(e.publishedAt || 0).getFullYear()).filter(Boolean);
  const yearRange = years.length
    ? (Math.min(...years) === Math.max(...years) ? `${years[0]}` : `${Math.min(...years)}–${Math.max(...years)}`)
    : null;

  const resumeEntry = resumeTarget ? historyEntry(resumeTarget.id) : null;
  const resumeAt = resumeTarget ? resumePosition(resumeTarget.id) : 0;
  const resumeLabel = !resumeTarget ? 'Play'
    : resumeAt > 0 ? `Resume S${resumeTarget.season || 1}·E${resumeTarget.episode || 1} · ${timecode(resumeAt)}`
    : resumeEntry ? `Play S${resumeTarget.season || 1}·E${resumeTarget.episode || 1}`
    : 'Play from the start';

  return el('section', { class: 'series-hero' },
    series.backdrop || series.poster
      ? el('div', { class: 'series-hero-bg' }, el('img', { src: series.backdrop || series.poster, alt: '' }))
      : null,
    series.poster
      ? el('div', { class: 'series-hero-poster' }, el('img', { src: series.poster, alt: '' }))
      : null,
    el('div', { class: 'series-hero-body' },
      el('h1', { class: 'series-hero-title' }, series.title),
      el('div', { class: 'series-hero-meta' },
        [channel?.name,
         yearRange,
         `${episodes.length} episodes`,
         totalSeconds ? durationWords(totalSeconds) : null,
         totalViews ? `${compact(totalViews)} views` : null].filter(Boolean).join(' · ')),
      series.description ? el('p', { class: 'series-hero-desc' }, series.description) : null,
      el('div', { class: 'series-hero-actions' },
        resumeTarget
          ? button(resumeLabel, {
              variant: 'brand',
              onClick: () => navigate('/watch', { v: resumeTarget.id }),
            })
          : null,
        channel
          ? el('a', { class: 'btn btn-subtle', href: href(`/channel/${channel.handle || channel.id}`) },
              avatar(channel, 20), el('span', {}, channel.name))
          : null,
        channel ? subscribeButton(channel.id) : null)));
}

function episodeRow(ep, number) {
  const link = href('/watch', { v: ep.id });
  const progress = progressRatio(ep.id);
  const primary = thumbnailFor(ep);
  const fallback = thumbnailFallback(ep);

  const img = primary
    ? el('img', { class: 'thumb-img', src: primary, alt: '', loading: 'lazy' })
    : el('div', { class: 'thumb-placeholder' }, svgIcon('film', 28));
  if (primary && fallback) {
    img.addEventListener('error', () => { if (img.src !== fallback) img.src = fallback; });
  }

  return el('article', { class: 'episode-row' },
    el('span', { class: 'episode-num' }, String(ep.episode || number)),
    el('a', { class: 'thumb', href: link, 'aria-hidden': 'true', tabindex: '-1' },
      img,
      el('span', { class: 'thumb-duration' }, timecode(ep.durationSec)),
      progress > 0
        ? el('span', { class: 'thumb-progress' }, el('span', { style: { width: `${progress * 100}%` } }))
        : null),
    el('div', { class: 'card-text' },
      el('a', { class: 'card-title', href: link }, ep.title),
      el('div', { class: 'card-meta' },
        [`${compact(viewsOf(ep))} views`,
         ep.publishedAt ? longDate(ep.publishedAt) : null,
         progress > 0 && progress < 1 ? `${Math.round(progress * 100)}% watched` : null,
         progress >= 1 ? 'Watched' : null].filter(Boolean).join(' · ')),
      ep.description
        ? el('p', { class: 'card-desc', style: { '-webkit-line-clamp': '3' } }, ep.description)
        : null),
    el('div', { class: 'row-actions' },
      button('Play', { variant: 'subtle', onClick: () => navigate('/watch', { v: ep.id }) })));
}
