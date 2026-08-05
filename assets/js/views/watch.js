// Watch page: player, metadata, actions, series strip, up-next rail, comments.

import { el, compact, timeAgo, longDate, timecode, throttle } from '../util.js';
import { PATHS } from '../config.js';
import { readJSON, updateJSON, hasToken } from '../github.js';
import {
  store, getVideo, getChannel, getSeries, getPlaylist, playlistVideos,
  relatedTo, nextEpisode, videosOfSeries, seasonsOf, viewsOf, likesOf, ratingOf,
  rateVideo, resumePosition, recordProgress, markViewed, inWatchLater,
  toggleWatchLater, userPlaylist, setSetting,
} from '../store.js';
import {
  videoCard, avatar, subscribeButton, svgIcon, iconButton, button, toast,
  emptyState, expandableText, openPlaylistPicker,
} from '../components.js';
import { createPlayer } from '../player.js';
import { openMiniplayer, handoffPosition, closeMiniplayer } from '../miniplayer.js';
import { href, navigate } from '../router.js';
import { setView, onViewTeardown } from '../app.js';

/** How often the resume position is written to storage while playing. */
const SAVE_EVERY_MS = 5000;

export default function watchView({ query = {} }) {
  const video = getVideo(query.v);

  if (!store.ready && !store.catalog.videos.length) {
    setView(el('div', { class: 'watch' },
      el('div', {}, el('div', { class: 'player-stage skel' }))));
    return;
  }

  if (!video) {
    setView(emptyState('film', 'Video not found',
      'This title isn’t in the catalog. It may have been removed or the link may be wrong.',
      button('Back to home', { variant: 'primary', onClick: () => navigate('/') })),
      { title: 'Not found' });
    return;
  }

  const channel = getChannel(video.channelId);
  const series = video.seriesId ? getSeries(video.seriesId) : null;
  const playlist = query.list ? (getPlaylist(query.list) || userPlaylist(query.list)) : null;

  /* ---- where to start ---- */
  // If the miniplayer was showing this same video, pick up exactly where it got
  // to. Either way the miniplayer is dismissed — nothing should still be
  // playing behind the page you're now watching on.
  const handoff = handoffPosition(video.id);
  const explicitStart = Number(query.t);
  const startAt = Number.isFinite(explicitStart) && explicitStart > 0
    ? explicitStart
    : (handoff ?? resumePosition(video.id));
  closeMiniplayer();

  /* ---- queue ---- */
  const queue = playlist
    ? (playlist.videoIds || []).map(getVideo).filter(Boolean)
    : null;
  const queueIndex = queue ? queue.findIndex((v) => v.id === video.id) : -1;
  const upNext = queue && queueIndex >= 0 && queue[queueIndex + 1]
    ? queue[queueIndex + 1]
    : (nextEpisode(video) || relatedTo(video, 1)[0] || null);

  /* ---- layout ---- */
  const playerHost = el('div', { class: 'watch-player' });
  const wrap = el('div', { class: 'watch' });
  const main = el('div', { class: 'watch-main' });
  const side = el('aside', { class: 'watch-side' });
  wrap.append(main, side);

  main.append(playerHost);

  /* ---- player ---- */
  const player = createPlayer(playerHost, video, {
    startAt,
    autoplay: true,
    volume: store.settings.volume,
    muted: store.settings.muted,
    rate: store.settings.rate,
    onNext: upNext ? () => navigate('/watch', { v: upNext.id, ...(playlist ? { list: playlist.id } : {}) }) : null,
    nextLabel: upNext ? `Next: ${upNext.title}` : '',
  });

  markViewed(video.id);

  /* ---- progress persistence ---- */
  let lastSaved = 0;
  const saveProgress = () => {
    const t = player.getTime();
    if (t > 0) recordProgress(video.id, t, player.getDuration());
  };
  player.on('progress', throttle((t) => {
    if (Math.abs(t - lastSaved) < SAVE_EVERY_MS / 1000) return;
    lastSaved = t;
    saveProgress();
  }, 1000));
  player.on('pause', saveProgress);
  const saveTimer = setInterval(saveProgress, SAVE_EVERY_MS);

  player.on('volumechange', (v) => {
    setSetting('volume', v);
    setSetting('muted', v === 0);
  });
  player.on('ratechange', (r) => setSetting('rate', r));

  /* ---- autoplay next ---- */
  player.on('ended', () => {
    recordProgress(video.id, player.getDuration(), player.getDuration());
    if (!store.settings.autoplay || !upNext) return;
    const countdown = toast(`Up next: ${upNext.title}`, {
      duration: 5000,
      action: { label: 'Cancel', onClick: () => clearTimeout(timer) },
    });
    const timer = setTimeout(() => {
      countdown.remove();
      navigate('/watch', { v: upNext.id, ...(playlist ? { list: playlist.id } : {}) });
    }, 5000);
    onViewTeardown(() => clearTimeout(timer));
  });

  /* ---- theater & miniplayer ---- */
  let theater = false;
  player.on('theater', () => {
    theater = !theater;
    wrap.classList.toggle('is-theater', theater);
  });

  let handedOff = false;
  player.on('miniplayer', () => {
    handedOff = true;
    openMiniplayer(video, { startAt: Math.floor(player.getTime()), playing: player.isPlaying() });
    navigate('/');
  });

  /* ---- teardown ---- */
  const teardown = () => {
    clearInterval(saveTimer);
    saveProgress();
    // If the viewer sent it to the miniplayer, that instance owns playback now.
    if (!handedOff) {
      const stillPlaying = player.isPlaying();
      const at = Math.floor(player.getTime());
      player.destroy();
      if (stillPlaying && store.settings.autoplay) {
        openMiniplayer(video, { startAt: at, playing: true });
      }
    } else {
      player.destroy();
    }
  };
  onViewTeardown(teardown);

  /* ---- title + actions ---- */
  main.append(
    el('h1', { class: 'watch-title' }, video.title),
    buildActions(video, channel, player),
    buildDescription(video, channel, player),
    series ? buildSeriesStrip(series, video, playlist) : null,
    playlist ? buildPlaylistStrip(playlist, video) : null,
    buildComments(video));

  /* ---- up next rail ---- */
  side.append(buildUpNext(video, queue, queueIndex, playlist));

  setView(wrap, { title: video.title });
}

/* ---------- actions row ---------- */

function buildActions(video, channel, player) {
  const rateGroup = el('div', { class: 'rate-group' });

  const paintRatings = () => {
    const rating = ratingOf(video.id);
    rateGroup.replaceChildren(
      el('button', {
        class: `rate-btn${rating === 1 ? ' is-active' : ''}`,
        'aria-pressed': String(rating === 1),
        'aria-label': 'Like',
        onclick: () => { rateVideo(video.id, 1); paintRatings(); },
      }, svgIcon('like', 20), el('span', {}, compact(likesOf(video)))),
      el('div', { class: 'rate-divider' }),
      el('button', {
        class: `rate-btn${rating === -1 ? ' is-active' : ''}`,
        'aria-pressed': String(rating === -1),
        'aria-label': 'Dislike',
        onclick: () => { rateVideo(video.id, -1); paintRatings(); },
      }, svgIcon('dislike', 20)));
  };
  paintRatings();

  const saveBtn = el('button', { class: 'btn btn-subtle' });
  const paintSave = () => {
    const saved = inWatchLater(video.id);
    saveBtn.replaceChildren(svgIcon(saved ? 'check' : 'clock', 20),
      el('span', {}, saved ? 'Saved' : 'Watch later'));
  };
  saveBtn.addEventListener('click', () => {
    const added = toggleWatchLater(video.id);
    paintSave();
    toast(added ? 'Saved to Watch later' : 'Removed from Watch later');
  });
  paintSave();

  const shareBtn = button('Share', {
    variant: 'subtle', icon: 'share',
    onClick: async () => {
      const at = Math.floor(player.getTime());
      const url = `${location.origin}${location.pathname}${href('/watch', { v: video.id, ...(at > 5 ? { t: at } : {}) })}`;
      if (navigator.share) {
        try { await navigator.share({ title: video.title, url }); return; } catch { /* fall through to copy */ }
      }
      try {
        await navigator.clipboard.writeText(url);
        toast(at > 5 ? `Link copied at ${timecode(at)}` : 'Link copied');
      } catch {
        toast('Could not copy the link');
      }
    },
  });

  return el('div', { class: 'watch-actions' },
    el('div', { class: 'watch-owner' },
      channel
        ? el('a', { href: href(`/channel/${channel.handle || channel.id}`), 'aria-label': channel.name }, avatar(channel, 40))
        : avatar({ name: 'Unknown' }, 40),
      el('div', { class: 'watch-owner-text' },
        el('a', { class: 'watch-owner-name', href: channel ? href(`/channel/${channel.handle || channel.id}`) : '#/' },
          channel?.name || 'Unknown channel',
          channel?.verified ? el('span', { class: 'verified' }, svgIcon('check', 12)) : null),
        el('div', { class: 'watch-owner-subs' },
          `${compact(channel?.subscribers || 0)} subscribers`)),
      channel ? subscribeButton(channel.id) : null),
    el('div', { class: 'action-row' },
      rateGroup,
      shareBtn,
      saveBtn,
      button('Save to playlist', {
        variant: 'subtle', icon: 'save',
        onClick: () => openPlaylistPicker(video),
      })));
}

/* ---------- description ---------- */

function buildDescription(video, channel, player) {
  const meta = [
    `${compact(viewsOf(video))} views`,
    video.publishedAt ? longDate(video.publishedAt) : null,
    video.year && !video.publishedAt ? String(video.year) : null,
    video.rating || null,
  ].filter(Boolean).join(' · ');

  const topics = (video.topics || []).map((t) =>
    el('a', { class: 'hashtag', href: href('/results', { q: t }) }, `#${t.replace(/\s+/g, '')}`));

  return el('div', { class: 'watch-desc' },
    el('div', { class: 'watch-desc-meta' }, meta),
    topics.length ? el('div', { style: { marginBottom: '.5rem', display: 'flex', gap: '.5rem', flexWrap: 'wrap' } }, ...topics) : null,
    expandableText(video.description || 'No description.', {
      lines: 3,
      onSeek: (seconds) => { player.seek(seconds); player.play(); },
    }));
}

/* ---------- series strip ---------- */

function buildSeriesStrip(series, current, playlist) {
  const episodes = videosOfSeries(series.id);
  if (episodes.length < 2) return null;

  const seasons = seasonsOf(series.id);
  const currentSeason = seasons.find((s) => s.episodes.some((e) => e.id === current.id)) || seasons[0];

  const strip = el('div', { class: 'episode-strip' });
  const paint = (season) => {
    strip.replaceChildren(...season.episodes.map((ep) => {
      const node = el('a', {
        class: `episode-chip${ep.id === current.id ? ' is-current' : ''}`,
        href: href('/watch', { v: ep.id, ...(playlist ? { list: playlist.id } : {}) }),
      },
        el('span', { class: 'thumb' },
          el('img', { class: 'thumb-img', src: thumbSrc(ep), alt: '', loading: 'lazy' }),
          el('span', { class: 'thumb-duration' }, timecode(ep.durationSec))),
        el('span', { class: 'episode-chip-title' }, ep.title),
        el('span', { class: 'episode-chip-meta' }, `Episode ${ep.episode || '?'}`));
      return node;
    }));
    // Bring the current episode into view without scrolling the page.
    requestAnimationFrame(() => {
      strip.querySelector('.is-current')?.scrollIntoView({ block: 'nearest', inline: 'center' });
    });
  };
  paint(currentSeason);

  const seasonSelect = seasons.length > 1
    ? el('select', {
        class: 'select', style: { width: 'auto' },
        onchange: (e) => paint(seasons.find((s) => String(s.number) === e.target.value) || seasons[0]),
      }, ...seasons.map((s) => el('option', {
        value: String(s.number),
        selected: s.number === currentSeason.number || null,
      }, s.title)))
    : null;

  return el('section', { class: 'watch-series' },
    el('div', { class: 'watch-series-head' },
      el('div', {},
        el('h2', { class: 'section-title' }, series.title),
        el('div', { class: 'card-meta' }, `${episodes.length} episodes`)),
      el('div', { class: 'section-actions' },
        seasonSelect,
        el('a', { class: 'btn btn-subtle', href: href(`/series/${series.id}`) }, 'View series'))),
    strip);
}

function buildPlaylistStrip(playlist, current) {
  const videos = playlistVideos(playlist);
  if (!videos.length) return null;
  const index = videos.findIndex((v) => v.id === current.id);
  return el('section', { class: 'watch-series' },
    el('div', { class: 'watch-series-head' },
      el('div', {},
        el('h2', { class: 'section-title' }, playlist.title),
        el('div', { class: 'card-meta' }, `${index + 1} / ${videos.length}`)),
      el('a', { class: 'btn btn-subtle', href: href(`/playlist/${playlist.id}`) }, 'View playlist')),
    el('div', { class: 'episode-strip' },
      ...videos.map((v, i) => el('a', {
        class: `episode-chip${v.id === current.id ? ' is-current' : ''}`,
        href: href('/watch', { v: v.id, list: playlist.id }),
      },
        el('span', { class: 'thumb' },
          el('img', { class: 'thumb-img', src: thumbSrc(v), alt: '', loading: 'lazy' }),
          el('span', { class: 'thumb-duration' }, timecode(v.durationSec))),
        el('span', { class: 'episode-chip-title' }, v.title),
        el('span', { class: 'episode-chip-meta' }, `#${i + 1}`)))));
}

function thumbSrc(video) {
  if (video.thumbnail) return video.thumbnail;
  if (video.source?.type === 'youtube') return `https://i.ytimg.com/vi/${video.source.youtubeId}/mqdefault.jpg`;
  return video.source?.poster || '';
}

/* ---------- up next ---------- */

function buildUpNext(video, queue, queueIndex, playlist) {
  const autoplayToggle = el('label', { class: 'autoplay-toggle' },
    el('span', {}, 'Autoplay'),
    el('span', { class: 'switch' },
      el('input', {
        type: 'checkbox',
        checked: store.settings.autoplay || null,
        'aria-label': 'Autoplay next video',
        onchange: (e) => setSetting('autoplay', e.target.checked),
      }),
      el('span', { class: 'switch-track' })));

  const items = queue && queueIndex >= 0
    ? queue.slice(queueIndex + 1).concat(queue.slice(0, queueIndex))
    : relatedTo(video, 24);

  return el('div', {},
    el('div', { class: 'up-next-head' },
      el('h2', { class: 'section-title' }, playlist ? `Next in ${playlist.title}` : 'Up next'),
      autoplayToggle),
    el('div', { style: { display: 'grid', gap: '.65rem', marginTop: '.75rem' } },
      ...items.map((v) => videoCard(v, {
        layout: 'compact',
        playlistId: playlist?.id || null,
      }))));
}

/* ---------- comments ---------- */

function buildComments(video) {
  const section = el('section', { class: 'comments' });
  const listHost = el('div', {});
  let comments = [];

  const paint = () => {
    section.replaceChildren(
      el('div', { class: 'comments-head' },
        el('h2', { class: 'section-title' }, `${comments.length} ${comments.length === 1 ? 'comment' : 'comments'}`)),
      composer(),
      listHost);

    listHost.replaceChildren(...(comments.length
      ? comments.map(commentNode)
      : [el('p', { class: 'muted' }, 'No comments yet. Be the first to say something.')]));
  };

  const composer = () => {
    const input = el('textarea', {
      class: 'comment-input', rows: '1', placeholder: 'Add a comment…', maxlength: '2000',
      oninput: (e) => {
        e.target.style.height = 'auto';
        e.target.style.height = `${e.target.scrollHeight}px`;
        actions.hidden = !e.target.value.trim();
      },
    });
    const actions = el('div', { class: 'comment-composer-actions', hidden: true },
      button('Cancel', {
        variant: 'ghost',
        onClick: () => { input.value = ''; input.style.height = 'auto'; actions.hidden = true; },
      }),
      button('Comment', { variant: 'primary', onClick: () => submit(input, actions) }));

    return el('div', { class: 'comment-composer' },
      avatar(store.user, 40),
      el('div', { class: 'comment-composer-body' }, input, actions));
  };

  const submit = async (input, actions) => {
    const text = input.value.trim();
    if (!text) return;

    const comment = {
      id: `c_${Date.now().toString(36)}`,
      author: store.user.name || 'Guest',
      authorId: store.user.id,
      avatar: store.user.avatar || null,
      text,
      at: new Date().toISOString(),
      likes: 0,
    };

    // Optimistic: show it immediately, then try to persist.
    comments.unshift(comment);
    input.value = '';
    input.style.height = 'auto';
    actions.hidden = true;
    paint();

    if (!hasToken()) {
      toast('Comment shown locally — add a GitHub token in Settings to publish it.', { duration: 5000 });
      return;
    }
    try {
      await updateJSON(PATHS.comments(video.id), (data) => {
        const list = Array.isArray(data?.comments) ? data.comments : [];
        return { videoId: video.id, comments: [comment, ...list] };
      }, {
        message: `comment on ${video.id}`,
        fallback: { videoId: video.id, comments: [] },
      });
    } catch (err) {
      comments = comments.filter((c) => c.id !== comment.id);
      paint();
      toast(`Comment failed: ${err.message}`, { duration: 6000 });
    }
  };

  const commentNode = (c) => {
    const likeBtn = iconButton('like', 'Like this comment', () => {
      c.likes = (c.likes || 0) + 1;
      likeCount.textContent = c.likes ? String(c.likes) : '';
    }, { size: 18 });
    const likeCount = el('span', { class: 'comment-likes' }, c.likes ? String(c.likes) : '');

    return el('article', { class: 'comment' },
      avatar({ name: c.author, avatar: c.avatar }, 40),
      el('div', { class: 'comment-body' },
        el('div', { class: 'comment-head' },
          el('span', { class: 'comment-author' }, c.author),
          el('span', { class: 'comment-time' }, timeAgo(c.at))),
        el('div', { class: 'comment-text' }, c.text),
        el('div', { class: 'comment-actions' }, likeBtn, likeCount)));
  };

  paint();

  // Comments live in their own file per video, so this is one small extra fetch.
  readJSON(PATHS.comments(video.id))
    .then(({ data }) => {
      if (!Array.isArray(data?.comments)) return;
      comments = data.comments;
      paint();
    })
    .catch(() => { /* no comments file yet — the empty state is correct */ });

  return section;
}
