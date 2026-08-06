// Reusable UI pieces. Every function returns a detached DOM node.

import {
  el, esc, compact, timecode, timeAgo, durationWords, hueFrom, initials, clamp,
  setChildren,
} from './util.js';
import { href } from './router.js';
import {
  getChannel, getSeries, thumbnailFor, thumbnailFallback, viewsOf, progressRatio,
  isSubscribed, toggleSubscribe, inWatchLater, toggleWatchLater, store,
  userPlaylist, togglePlaylistVideo, createPlaylist, removeFromHistory, events,
} from './store.js';
import { ICONS, icon } from './player.js';

/* ---------- primitives ---------- */

export const UI_ICONS = {
  home: '<path fill="currentColor" d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z"/>',
  compass: '<path fill="currentColor" d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm2.9 12.9L6 18l3.1-8.9L18 6l-3.1 8.9z"/>',
  subs: '<path fill="currentColor" d="M10 18v-6l5 3-5 3zm7-15H7v2h10V3zm3 4H4v2h16V7zm2 4H2v10h20V11z"/>',
  library: '<path fill="currentColor" d="M4 6H2v14a2 2 0 0 0 2 2h14v-2H4V6zm16-4H8a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2zm-9 12V6l6 4-6 4z"/>',
  history: '<path fill="currentColor" d="M13 3a9 9 0 0 0-9 9H1l3.9 3.9.1.2L9 12H6a7 7 0 1 1 2 4.9l-1.4 1.4A9 9 0 1 0 13 3zm-1 5v5l4.3 2.5.7-1.2-3.5-2.1V8H12z"/>',
  clock: '<path fill="currentColor" d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 18a8 8 0 1 1 0-16 8 8 0 0 1 0 16zm.5-13H11v6l5.2 3.2.8-1.3-4.5-2.7V7z"/>',
  like: '<path fill="currentColor" d="M2 20h3V9H2v11zm19.8-9.3c.1-.2.2-.5.2-.7v-1c0-1.1-.9-2-2-2h-5.2l.8-3.8v-.3c0-.4-.2-.8-.4-1.1L14.2 1 7.6 7.6c-.4.4-.6.9-.6 1.4v9c0 1.1.9 2 2 2h9c.8 0 1.5-.5 1.8-1.2l3-7z"/>',
  dislike: '<path fill="currentColor" d="M22 4h-3v11h3V4zM2.2 13.3c-.1.2-.2.5-.2.7v1c0 1.1.9 2 2 2h5.2l-.8 3.8v.3c0 .4.2.8.4 1.1l.9.8 6.6-6.6c.4-.4.6-.9.6-1.4V6c0-1.1-.9-2-2-2H6c-.8 0-1.5.5-1.8 1.2l-2 7.1z"/>',
  share: '<path fill="currentColor" d="M18 16.1c-.8 0-1.5.3-2 .8l-7.1-4.2c.1-.2.1-.4.1-.7s0-.5-.1-.7L16 7.2c.5.5 1.2.8 2 .8a3 3 0 1 0-3-3c0 .3 0 .5.1.7L8.1 9.9c-.5-.5-1.3-.8-2.1-.8a3 3 0 1 0 0 6c.8 0 1.5-.3 2.1-.8l7 4.1v.5a2.9 2.9 0 1 0 2.9-2.8z"/>',
  save: '<path fill="currentColor" d="M22 13h-4v4h-2v-4h-4v-2h4V7h2v4h4v2zM14 7H2v2h12V7zm0 4H2v2h12v-2zM2 17h8v-2H2v2z"/>',
  more: '<path fill="currentColor" d="M12 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4zm0 2a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm0 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4z"/>',
  search: '<path fill="currentColor" d="M20.9 19.5l-4.6-4.6a7.5 7.5 0 1 0-1.4 1.4l4.6 4.6 1.4-1.4zM10.5 16a5.5 5.5 0 1 1 0-11 5.5 5.5 0 0 1 0 11z"/>',
  menu: '<path fill="currentColor" d="M3 6h18v2H3V6zm0 5h18v2H3v-2zm0 5h18v2H3v-2z"/>',
  back: '<path fill="currentColor" d="M20 11H7.8l5.6-5.6L12 4l-8 8 8 8 1.4-1.4L7.8 13H20v-2z"/>',
  trash: '<path fill="currentColor" d="M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/>',
  check: '<path fill="currentColor" d="M9 16.2L4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4L9 16.2z"/>',
  plus: '<path fill="currentColor" d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/>',
  bell: '<path fill="currentColor" d="M12 22a2 2 0 0 0 2-2h-4a2 2 0 0 0 2 2zm6-6v-5a6 6 0 0 0-5-5.9V4a1 1 0 1 0-2 0v1.1A6 6 0 0 0 6 11v5l-2 2v1h16v-1l-2-2z"/>',
  studio: '<path fill="currentColor" d="M17 10.5V7a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-3.5l4 4v-11l-4 4z"/>',
  settings: ICONS.settings,
  film: '<path fill="currentColor" d="M18 3v2h-2V3H8v2H6V3H4v18h2v-2h2v2h8v-2h2v2h2V3h-2zM8 17H6v-2h2v2zm0-4H6v-2h2v2zm0-4H6V7h2v2zm10 8h-2v-2h2v2zm0-4h-2v-2h2v2zm0-4h-2V7h2v2z"/>',
  globe: '<path fill="currentColor" d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm6.9 6h-2.9a15.6 15.6 0 0 0-1.3-3.4A8 8 0 0 1 18.9 8zM12 4a14 14 0 0 1 1.7 4h-3.4A14 14 0 0 1 12 4zM4.3 14a8 8 0 0 1 0-4h3.3a16.5 16.5 0 0 0 0 4H4.3zm.8 2h2.9c.3 1.2.8 2.3 1.3 3.4A8 8 0 0 1 5.1 16zm2.9-8H5.1a8 8 0 0 1 4.2-3.4A15.6 15.6 0 0 0 8 8zm4 12a14 14 0 0 1-1.7-4h3.4A14 14 0 0 1 12 20zm2.1-6H9.9a14.7 14.7 0 0 1 0-4h4.2a14.7 14.7 0 0 1 0 4zm.6 5.4c.5-1.1 1-2.2 1.3-3.4h2.9a8 8 0 0 1-4.2 3.4zm1.7-5.4a16.5 16.5 0 0 0 0-4h3.3a8 8 0 0 1 0 4h-3.3z"/>',
};

export const svgIcon = (name, size = 24) => icon(UI_ICONS[name] || UI_ICONS.more, { size });

export function iconButton(name, label, onClick, { size = 24, className = '' } = {}) {
  return el('button', {
    class: `icon-btn ${className}`.trim(),
    'aria-label': label,
    title: label,
    onclick: onClick,
  }, svgIcon(name, size));
}

export function button(label, { variant = 'primary', onClick, icon: iconName, disabled, className = '' } = {}) {
  return el('button', {
    class: `btn btn-${variant} ${className}`.trim(),
    disabled: disabled || null,
    onclick: onClick,
  }, iconName ? svgIcon(iconName, 20) : null, el('span', {}, label));
}

/* ---------- avatars & images ---------- */

export function avatar(entity, size = 40) {
  const name = entity?.name || 'Guest';
  const src = entity?.avatar;
  if (src) {
    return el('img', {
      class: 'avatar', src, alt: '', loading: 'lazy',
      width: size, height: size,
      style: { width: `${size}px`, height: `${size}px` },
      onerror: (e) => e.target.replaceWith(letterAvatar(name, size)),
    });
  }
  return letterAvatar(name, size);
}

function letterAvatar(name, size) {
  const hue = hueFrom(name);
  return el('span', {
    class: 'avatar avatar-letter',
    'aria-hidden': 'true',
    style: {
      width: `${size}px`, height: `${size}px`,
      fontSize: `${Math.max(10, size * 0.4)}px`,
      background: `linear-gradient(140deg, hsl(${hue} 62% 46%), hsl(${(hue + 42) % 360} 62% 34%))`,
    },
  }, initials(name));
}

/** Thumbnail <img> that falls back to the poster, then to a glyph. */
export function thumbImage(video, alt = '') {
  const primary = thumbnailFor(video);
  const fallback = thumbnailFallback(video);
  if (!primary) {
    return el('div', { class: 'thumb-placeholder' }, svgIcon('film', 32));
  }
  const img = el('img', {
    class: 'thumb-img', src: primary, alt, loading: 'lazy', decoding: 'async',
  });

  const degrade = () => {
    if (fallback && img.src !== fallback) img.src = fallback;
    else img.replaceWith(el('div', { class: 'thumb-placeholder' }, svgIcon('film', 32)));
  };

  img.addEventListener('error', degrade);
  return img;
}

/* ---------- video cards ---------- */

/**
 * @param video   catalog record
 * @param layout  'grid' (default) | 'row' (search results) | 'compact' (sidebar)
 */
export function videoCard(video, {
  layout = 'grid', showChannel = true, showDescription = false,
  playlistId = null, index = null, onRemove = null, menu = true,
} = {}) {
  if (!video) return null;
  const channel = getChannel(video.channelId);
  const series = video.seriesId ? getSeries(video.seriesId) : null;
  const link = href('/watch', { v: video.id, ...(playlistId ? { list: playlistId } : {}) });
  const progress = progressRatio(video.id);

  const thumb = el('a', { class: 'thumb', href: link, tabindex: '-1', 'aria-hidden': 'true' },
    thumbImage(video, video.title),
    el('span', { class: 'thumb-duration' }, timecode(video.durationSec)),
    progress > 0
      ? el('span', { class: 'thumb-progress' }, el('span', { style: { width: `${clamp(progress, 0, 1) * 100}%` } }))
      : null,
    series ? el('span', { class: 'thumb-badge' }, `S${video.season || 1}·E${video.episode || 1}`) : null);

  const metaLine = [
    `${compact(viewsOf(video))} views`,
    video.publishedAt ? timeAgo(video.publishedAt) : null,
  ].filter(Boolean).join(' · ');

  const titleEl = el('a', { class: 'card-title', href: link, title: video.title }, video.title);

  const channelLine = showChannel && channel
    ? el('a', { class: 'card-channel', href: href(`/channel/${channel.handle || channel.id}`) },
        channel.name,
        channel.verified ? el('span', { class: 'verified', title: 'Verified' }, svgIcon('check', 12)) : null)
    : null;

  const body = el('div', { class: 'card-body' },
    layout === 'grid' && showChannel && channel
      ? el('a', { class: 'card-avatar', href: href(`/channel/${channel.handle || channel.id}`), 'aria-label': channel.name }, avatar(channel, 36))
      : null,
    el('div', { class: 'card-text' },
      titleEl,
      channelLine,
      el('div', { class: 'card-meta' }, metaLine),
      showDescription && video.description
        ? el('p', { class: 'card-desc' }, video.description.slice(0, 180))
        : null),
    menu ? videoMenuButton(video, { playlistId, onRemove }) : null);

  return el('article', {
    class: `video-card layout-${layout}`,
    dataset: { videoId: video.id },
  },
    index !== null ? el('span', { class: 'card-index' }, String(index)) : null,
    thumb, body);
}

export function videoCardSkeleton(layout = 'grid') {
  return el('div', { class: `video-card layout-${layout} is-skeleton` },
    el('div', { class: 'thumb skel' }),
    el('div', { class: 'card-body' },
      layout === 'grid' ? el('div', { class: 'card-avatar skel skel-circle' }) : null,
      el('div', { class: 'card-text' },
        el('div', { class: 'skel skel-line w-90' }),
        el('div', { class: 'skel skel-line w-60' }),
        el('div', { class: 'skel skel-line w-40' }))));
}

/* ---------- the ⋮ menu on every card ---------- */

function videoMenuButton(video, { playlistId = null, onRemove = null } = {}) {
  const btn = iconButton('more', 'More actions', (e) => {
    e.preventDefault();
    e.stopPropagation();
    openVideoMenu(video, btn, { playlistId, onRemove });
  }, { size: 20, className: 'card-menu-btn' });
  return btn;
}

let openMenuEl = null;

export function closeAnyMenu() {
  openMenuEl?.remove();
  openMenuEl = null;
}

/** Hand a popup menu to the shared "only one open at a time" handling. */
export function registerOpenMenu(menu) {
  openMenuEl = menu;
  menu.querySelector('button:not([disabled])')?.focus();
}
document.addEventListener('click', closeAnyMenu);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeAnyMenu(); });

function openVideoMenu(video, anchor, { playlistId, onRemove }) {
  closeAnyMenu();
  const items = [
    {
      label: inWatchLater(video.id) ? 'Remove from Watch later' : 'Save to Watch later',
      icon: 'clock',
      action: () => {
        const added = toggleWatchLater(video.id);
        toast(added ? 'Saved to Watch later' : 'Removed from Watch later');
      },
    },
    { label: 'Save to playlist', icon: 'save', action: () => openPlaylistPicker(video) },
    {
      label: 'Copy link',
      icon: 'share',
      action: async () => {
        const url = `${location.origin}${location.pathname}${href('/watch', { v: video.id })}`;
        try {
          await navigator.clipboard.writeText(url);
          toast('Link copied');
        } catch {
          toast('Could not copy — your browser blocked it');
        }
      },
    },
  ];

  if (playlistId && userPlaylist(playlistId)) {
    items.push({
      label: 'Remove from this playlist',
      icon: 'trash',
      action: () => { togglePlaylistVideo(playlistId, video.id); toast('Removed from playlist'); onRemove?.(); },
    });
  }
  if (onRemove && !playlistId) {
    items.push({
      label: 'Remove from watch history',
      icon: 'trash',
      action: () => { removeFromHistory(video.id); toast('Removed from history'); onRemove?.(); },
    });
  }

  const menu = el('div', { class: 'popmenu', role: 'menu' },
    ...items.map((item) => el('button', {
      class: 'popmenu-item', role: 'menuitem',
      onclick: (e) => { e.stopPropagation(); closeAnyMenu(); item.action(); },
    }, svgIcon(item.icon, 20), el('span', {}, item.label))));

  document.body.append(menu);
  positionMenu(menu, anchor);
  openMenuEl = menu;
  menu.addEventListener('click', (e) => e.stopPropagation());
  menu.querySelector('button')?.focus();
}

function positionMenu(menu, anchor) {
  const rect = anchor.getBoundingClientRect();
  const { width, height } = menu.getBoundingClientRect();
  const left = clamp(rect.right - width, 8, window.innerWidth - width - 8);
  const spaceBelow = window.innerHeight - rect.bottom;
  const top = spaceBelow > height + 12 ? rect.bottom + 6 : rect.top - height - 6;
  menu.style.left = `${left}px`;
  menu.style.top = `${clamp(top, 8, window.innerHeight - height - 8)}px`;
}

/* ---------- playlist picker ---------- */

export function openPlaylistPicker(video) {
  const listWrap = el('div', { class: 'picker-list' });

  const paint = () => {
    setChildren(listWrap,
      ...store.user.playlists.map((pl) => el('label', { class: 'picker-row' },
        el('input', {
          type: 'checkbox',
          checked: pl.videoIds.includes(video.id) || null,
          onchange: () => {
            togglePlaylistVideo(pl.id, video.id);
            countEl.textContent = `${pl.videoIds.length} videos`;
          },
        }),
        el('span', { class: 'picker-name' }, pl.title),
        el('span', { class: 'picker-count' }, `${pl.videoIds.length}`))),
      store.user.playlists.length ? null : el('p', { class: 'muted' }, 'No playlists yet.'));
  };
  const countEl = el('span');
  paint();

  const nameInput = el('input', { class: 'input', placeholder: 'New playlist name', maxlength: '100' });

  modal({
    title: 'Save to…',
    body: el('div', {},
      listWrap,
      el('div', { class: 'picker-new' },
        nameInput,
        button('Create', {
          variant: 'secondary',
          onClick: () => {
            const title = nameInput.value.trim();
            if (!title) { nameInput.focus(); return; }
            const pl = createPlaylist(title, { videoIds: [video.id] });
            nameInput.value = '';
            paint();
            toast(`Saved to ${pl.title}`);
          },
        }))),
    actions: [{ label: 'Done', variant: 'primary', close: true }],
  });
}

/* ---------- channel / series / playlist cards ---------- */

export function subscribeButton(channelId, { size = 'md' } = {}) {
  const render = () => {
    const on = isSubscribed(channelId);
    btn.className = `btn btn-${on ? 'subtle' : 'primary'} subscribe-btn size-${size}`;
    setChildren(btn,
      on ? svgIcon('bell', 18) : null,
      el('span', {}, on ? 'Subscribed' : 'Subscribe'));
    btn.setAttribute('aria-label', on ? 'Subscribed — click to unsubscribe' : 'Subscribe');
    btn.setAttribute('aria-pressed', String(on));
  };
  const btn = el('button', {
    onclick: (e) => {
      e.preventDefault();
      e.stopPropagation();
      const added = toggleSubscribe(channelId);
      render();
      toast(added ? 'Subscribed' : 'Unsubscribed');
    },
  });
  render();

  // These buttons are created on every card render, so a plain subscription
  // here leaks one listener per card for the life of the session. Drop it the
  // first time the button is found detached from the document.
  const off = events.on('user', () => {
    if (!btn.isConnected) { off(); return; }
    render();
  });
  return btn;
}

export function channelCard(channel, { compactMode = false } = {}) {
  if (!channel) return null;
  const link = href(`/channel/${channel.handle || channel.id}`);
  return el('article', { class: `channel-card${compactMode ? ' is-compact' : ''}` },
    el('a', { class: 'channel-card-avatar', href: link, 'aria-label': channel.name },
      avatar(channel, compactMode ? 56 : 88)),
    el('div', { class: 'channel-card-body' },
      el('a', { class: 'channel-card-name', href: link },
        channel.name,
        channel.verified ? el('span', { class: 'verified' }, svgIcon('check', 12)) : null),
      el('div', { class: 'card-meta' },
        [channel.handle ? `@${channel.handle}` : null,
         `${compact(channel.subscribers || 0)} subscribers`].filter(Boolean).join(' · ')),
      channel.tagline ? el('p', { class: 'card-desc' }, channel.tagline) : null),
    subscribeButton(channel.id, { size: 'sm' }));
}

export function seriesCard(series) {
  if (!series) return null;
  const link = href(`/series/${series.id}`);
  const channel = getChannel(series.channelId);
  const episodeCount = (series.seasons || []).reduce((n, s) => n + (s.episodes?.length || 0), 0);
  return el('article', { class: 'series-card' },
    el('a', { class: 'series-poster', href: link, 'aria-label': series.title },
      series.poster
        ? el('img', { src: series.poster, alt: '', loading: 'lazy' })
        : el('div', { class: 'thumb-placeholder' }, svgIcon('film', 28)),
      el('span', { class: 'series-badge' }, 'Series')),
    el('div', { class: 'card-text' },
      el('a', { class: 'card-title', href: link }, series.title),
      el('div', { class: 'card-meta' },
        [channel?.name, episodeCount ? `${episodeCount} episodes` : null].filter(Boolean).join(' · '))));
}

export function playlistCard(playlist, { owned = false } = {}) {
  if (!playlist) return null;
  const link = href(`/playlist/${playlist.id}`);
  const videos = (playlist.videoIds || []).map((id) => store.index.video.get(id)).filter(Boolean);
  const cover = videos[0];
  return el('article', { class: 'playlist-card' },
    el('a', { class: 'thumb playlist-thumb', href: link, 'aria-label': playlist.title },
      cover ? thumbImage(cover, '') : el('div', { class: 'thumb-placeholder' }, svgIcon('library', 32)),
      el('span', { class: 'playlist-count' }, svgIcon('library', 16), `${videos.length}`)),
    el('div', { class: 'card-text' },
      el('a', { class: 'card-title', href: link }, playlist.title),
      el('div', { class: 'card-meta' },
        owned ? `${playlist.visibility === 'public' ? 'Public' : 'Private'} playlist` : 'Playlist')));
}

/* ---------- layout helpers ---------- */

export function grid(items, { className = '' } = {}) {
  return el('div', { class: `video-grid ${className}`.trim() }, ...items.filter(Boolean));
}

/** A horizontally scrolling row with a title, like YouTube's shelves. */
export function shelf(title, items, { link = null, linkLabel = 'See all' } = {}) {
  if (!items.length) return null;
  return el('section', { class: 'shelf' },
    el('div', { class: 'shelf-head' },
      el('h2', { class: 'shelf-title' }, title),
      link ? el('a', { class: 'shelf-link', href: link }, linkLabel) : null),
    el('div', { class: 'shelf-scroller' }, ...items.filter(Boolean)));
}

export function sectionTitle(text, actions = null) {
  return el('div', { class: 'section-head' },
    el('h2', { class: 'section-title' }, text),
    actions ? el('div', { class: 'section-actions' }, actions) : null);
}

export function chipBar(items, active, onSelect) {
  const bar = el('div', { class: 'chipbar', role: 'tablist' });
  const all = ['All', ...items];
  for (const item of all) {
    bar.append(el('button', {
      class: `chip${item === active ? ' is-active' : ''}`,
      role: 'tab',
      'aria-selected': String(item === active),
      onclick: () => onSelect(item === 'All' ? null : item),
    }, item));
  }
  return bar;
}

export function tabs(items, activeId, onSelect) {
  return el('div', { class: 'tabs', role: 'tablist' },
    ...items.map((t) => el('button', {
      class: `tab${t.id === activeId ? ' is-active' : ''}`,
      role: 'tab',
      'aria-selected': String(t.id === activeId),
      onclick: () => onSelect(t.id),
    }, t.label)));
}

export function emptyState(iconName, title, body, action = null) {
  return el('div', { class: 'empty' },
    el('div', { class: 'empty-icon' }, svgIcon(iconName, 48)),
    el('h2', { class: 'empty-title' }, title),
    body ? el('p', { class: 'empty-body' }, body) : null,
    action);
}

export function skeletonGrid(count = 12, layout = 'grid') {
  return grid(Array.from({ length: count }, () => videoCardSkeleton(layout)));
}

/* ---------- toast & modal ---------- */

let toastHost = null;

export function toast(message, { duration = 2800, action = null } = {}) {
  if (!toastHost) {
    toastHost = el('div', { class: 'toast-host', 'aria-live': 'polite' });
    document.body.append(toastHost);
  }
  const node = el('div', { class: 'toast' },
    el('span', {}, message),
    action ? el('button', { class: 'toast-action', onclick: () => { node.remove(); action.onClick(); } }, action.label) : null);
  toastHost.append(node);
  requestAnimationFrame(() => node.classList.add('is-in'));
  setTimeout(() => {
    node.classList.remove('is-in');
    setTimeout(() => node.remove(), 250);
  }, duration);
  return node;
}

/**
 * @param actions [{ label, variant, close, onClick }] — onClick may return false
 *                to keep the dialog open.
 */
export function modal({ title, body, actions = [], onClose = null, wide = false }) {
  const dialog = el('div', { class: `modal${wide ? ' is-wide' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title });
  const backdrop = el('div', { class: 'modal-backdrop' }, dialog);

  const close = () => {
    backdrop.classList.remove('is-in');
    setTimeout(() => backdrop.remove(), 180);
    document.removeEventListener('keydown', onKey);
    onClose?.();
  };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };

  dialog.append(
    el('div', { class: 'modal-head' },
      el('h2', { class: 'modal-title' }, title),
      iconButton('more', 'Close', close, { size: 20, className: 'modal-close' })),
    el('div', { class: 'modal-body' }, body),
    actions.length
      ? el('div', { class: 'modal-actions' },
          ...actions.map((a) => button(a.label, {
            variant: a.variant || 'ghost',
            onClick: () => {
              const result = a.onClick?.();
              if (a.close !== false && result !== false) close();
            },
          })))
      : null);

  // Replace the placeholder glyph on the close button with a real ✕.
  dialog.querySelector('.modal-close')?.replaceChildren(icon(ICONS.close, { size: 20 }));

  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
  document.addEventListener('keydown', onKey);
  document.body.append(backdrop);
  requestAnimationFrame(() => backdrop.classList.add('is-in'));
  dialog.querySelector('input, textarea, button')?.focus();

  return { close, dialog };
}

export function confirmDialog(title, message, { confirmLabel = 'Delete', danger = true } = {}) {
  return new Promise((resolve) => {
    modal({
      title,
      body: el('p', {}, message),
      onClose: () => resolve(false),
      actions: [
        { label: 'Cancel', variant: 'ghost', onClick: () => resolve(false) },
        { label: confirmLabel, variant: danger ? 'danger' : 'primary', onClick: () => resolve(true) },
      ],
    });
  });
}

/* ---------- misc ---------- */

export function metaRow(video) {
  const parts = [
    `${compact(viewsOf(video))} views`,
    video.publishedAt ? timeAgo(video.publishedAt) : null,
    durationWords(video.durationSec),
    video.year ? String(video.year) : null,
    video.rating || null,
  ].filter(Boolean);
  return el('div', { class: 'meta-row' }, parts.join(' · '));
}

/** Collapsible description with clickable #tags and t=90 timestamps. */
export function expandableText(text, { lines = 3, onSeek = null } = {}) {
  const wrap = el('div', { class: 'expandable is-clamped', style: { '--clamp': String(lines) } });
  const content = el('div', { class: 'expandable-content' });
  content.innerHTML = linkify(text, Boolean(onSeek));
  if (onSeek) {
    content.addEventListener('click', (e) => {
      const stamp = e.target.closest('[data-seek]');
      if (!stamp) return;
      e.preventDefault();
      onSeek(Number(stamp.dataset.seek));
    });
  }
  const toggle = el('button', {
    class: 'expandable-toggle',
    hidden: true,
    onclick: () => {
      const clamped = wrap.classList.toggle('is-clamped');
      toggle.textContent = clamped ? 'Show more' : 'Show less';
    },
  }, 'Show more');
  wrap.append(content, toggle);

  // Only offer "Show more" when there is more. Measured after layout, since
  // the node isn't in the document yet.
  requestAnimationFrame(() => {
    toggle.hidden = content.scrollHeight <= content.clientHeight + 2;
  });
  return wrap;
}

/** Turn URLs, #tags and 1:23 timestamps into links. Input is escaped first. */
function linkify(text, withTimestamps) {
  let html = esc(text).replace(/\n/g, '<br>');
  html = html.replace(/(https?:\/\/[^\s<]+)/g,
    '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
  if (withTimestamps) {
    html = html.replace(/\b(\d{1,2}):([0-5]\d)(?::([0-5]\d))?\b/g, (match, a, b, c) => {
      const seconds = c ? Number(a) * 3600 + Number(b) * 60 + Number(c)
                        : Number(a) * 60 + Number(b);
      return `<a href="#" class="timestamp" data-seek="${seconds}">${match}</a>`;
    });
  }
  html = html.replace(/(^|\s)#([\w-]{2,30})/g,
    (m, space, tag) => `${space}<a class="hashtag" href="${href('/results', { q: tag })}">#${tag}</a>`);
  return html;
}
