// Bootstrap: theme, chrome (topbar + sidebar), routes, sync, service worker.

import { SITE, TOPICS } from './config.js';
import { $, el, debounce, setChildren } from './util.js';
import {
  store, events, loadLocal, loadCatalog, searchVideos, searchChannels, searchSeries,
  getChannel,
} from './store.js';
import * as sync from './sync.js';
import { route, start as startRouter, resolve, navigate, href, parseHash, routerEvents } from './router.js';
import { avatar, svgIcon, toast, emptyState, button } from './components.js';

import homeView from './views/home.js';
import watchView from './views/watch.js';
import channelView from './views/channel.js';
import seriesView from './views/series.js';
import searchView from './views/search.js';
import libraryView from './views/library.js';
import playlistView from './views/playlist.js';
import studioView from './views/studio.js';
import settingsView from './views/settings.js';

const viewHost = $('#view');
let viewTeardowns = [];

/**
 * Views register teardown work here (player disposal, timers, intervals).
 * Everything registered is run — and cleared — just before the next route's
 * handler builds anything, so a view can register more than once.
 */
export function onViewTeardown(fn) { viewTeardowns.push(fn); }

function runViewTeardowns() {
  const fns = viewTeardowns;
  viewTeardowns = [];
  for (const fn of fns) {
    try { fn(); } catch (err) { console.error('[teardown]', err); }
  }
}

/** Swap the main content area. `content` is a node or array of nodes. */
export function setView(content, { title } = {}) {
  viewHost.replaceChildren(...(Array.isArray(content) ? content.flat(Infinity).filter(Boolean) : [content]));
  document.title = title ? `${title} — ${SITE.name}` : `${SITE.name} — ${SITE.tagline}`;
}

/* ---------- theme ---------- */

export function applyTheme() {
  const pref = store.settings.theme || 'dark';
  const resolved = pref === 'system'
    ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
    : pref;
  document.documentElement.dataset.theme = resolved;
  document.querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', resolved === 'light' ? '#ffffff' : '#0f0f0f');
}

matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
  if (store.settings.theme === 'system') applyTheme();
});

/* ---------- sidebar ---------- */

function navLink(path, label, iconName, { exact = false, count = null } = {}) {
  const link = el('a', { class: 'nav-item', href: href(path) },
    svgIcon(iconName, 22),
    el('span', { class: 'nav-label' }, label),
    count !== null ? el('span', { class: 'nav-count' }, String(count)) : null);
  link.dataset.match = path;
  link.dataset.exact = String(exact);
  return link;
}

function buildSidebar() {
  const nav = $('#sidebar');
  const subs = store.user.subscriptions.map(getChannel).filter(Boolean);

  setChildren(nav,
    el('div', { class: 'nav-group' },
      navLink('/', 'Home', 'home', { exact: true }),
      navLink('/explore', 'Explore', 'compass'),
      navLink('/subscriptions', 'Subscriptions', 'subs')),

    el('div', { class: 'nav-group' },
      el('div', { class: 'nav-group-title' }, 'You'),
      navLink('/history', 'History', 'history'),
      navLink('/playlists', 'Playlists', 'library'),
      navLink('/watch-later', 'Watch later', 'clock', { count: store.user.watchLater.length || null }),
      navLink('/liked', 'Liked videos', 'like')),

    subs.length
      ? el('div', { class: 'nav-group' },
          el('div', { class: 'nav-group-title' }, 'Subscriptions'),
          ...subs.slice(0, 12).map((c) => el('a', {
            class: 'nav-item', href: href(`/channel/${c.handle || c.id}`), dataset: { match: `/channel/${c.handle || c.id}` },
          }, avatar(c, 24), el('span', { class: 'nav-label' }, c.name))))
      : null,

    el('div', { class: 'nav-group' },
      el('div', { class: 'nav-group-title' }, 'Topics'),
      ...TOPICS.slice(0, 8).map((topic) => el('a', {
        class: 'nav-item', href: href('/results', { q: topic }),
      }, svgIcon('globe', 20), el('span', { class: 'nav-label' }, topic)))),

    el('div', { class: 'nav-group' },
      navLink('/studio', 'Studio', 'studio'),
      navLink('/settings', 'Settings', 'settings')),

    el('div', { class: 'sidebar-footer' },
      el('div', {}, `${store.catalog.videos.length} titles · ${store.catalog.channels.length} channels`),
      el('div', {}, `${SITE.name}`)));

  highlightNav();
}

function highlightNav() {
  const { path } = parseHash();
  for (const link of document.querySelectorAll('.nav-item')) {
    const match = link.dataset.match;
    if (!match) { link.classList.remove('is-active'); continue; }
    const active = link.dataset.exact === 'true'
      ? path === match
      : path === match || path.startsWith(`${match}/`);
    link.classList.toggle('is-active', active);
  }
}

/* ---------- mobile nav ---------- */

function setNavOpen(open) {
  document.body.classList.toggle('nav-open', open);
  $('#menu-toggle').setAttribute('aria-expanded', String(open));
  $('#sidebar-scrim').hidden = !open;
}

function wireNav() {
  $('#menu-toggle').addEventListener('click', () => {
    setNavOpen(!document.body.classList.contains('nav-open'));
  });
  $('#sidebar-scrim').addEventListener('click', () => setNavOpen(false));
  $('#sidebar').addEventListener('click', (e) => {
    if (e.target.closest('a') && window.innerWidth <= 1000) setNavOpen(false);
  });
}

/* ---------- search ---------- */

function wireSearch() {
  const form = $('#search-form');
  const input = $('#search-input');
  const clear = $('#search-clear');
  const list = $('#search-suggest');
  let activeIndex = -1;

  const closeSuggest = () => {
    list.hidden = true;
    list.replaceChildren();
    activeIndex = -1;
    input.setAttribute('aria-expanded', 'false');
  };

  const suggest = debounce(() => {
    const q = input.value.trim();
    clear.hidden = !q;
    if (q.length < 2) return closeSuggest();

    const results = [
      ...searchChannels(q).slice(0, 3).map((c) => ({
        kind: 'Channel', label: c.name, icon: 'subs',
        go: () => navigate(`/channel/${c.handle || c.id}`),
      })),
      ...searchSeries(q).slice(0, 3).map((s) => ({
        kind: 'Series', label: s.title, icon: 'film',
        go: () => navigate(`/series/${s.id}`),
      })),
      ...searchVideos(q).slice(0, 6).map((v) => ({
        kind: 'Video', label: v.title, icon: 'search',
        go: () => navigate('/watch', { v: v.id }),
      })),
    ];

    if (!results.length) return closeSuggest();

    list.replaceChildren(...results.map((r, i) => el('li', { role: 'presentation' },
      el('button', {
        class: 'suggest-item', type: 'button', role: 'option', dataset: { index: String(i) },
        onclick: () => { closeSuggest(); input.blur(); r.go(); },
      }, svgIcon(r.icon, 18),
         el('span', { class: 'suggest-text' }, r.label),
         el('span', { class: 'suggest-kind' }, r.kind)))));
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
  }, 140);

  input.addEventListener('input', suggest);
  input.addEventListener('focus', () => { if (input.value.trim().length >= 2) suggest(); });

  input.addEventListener('keydown', (e) => {
    const options = [...list.querySelectorAll('.suggest-item')];
    if (e.key === 'Escape') { closeSuggest(); return; }
    if (!options.length) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      activeIndex = (activeIndex + (e.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
      options.forEach((o, i) => o.classList.toggle('is-active', i === activeIndex));
      options[activeIndex].scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter' && activeIndex >= 0) {
      e.preventDefault();
      options[activeIndex].click();
    }
  });

  clear.addEventListener('click', () => {
    input.value = '';
    clear.hidden = true;
    closeSuggest();
    input.focus();
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const q = input.value.trim();
    closeSuggest();
    input.blur();
    document.body.classList.remove('search-open');
    if (q) navigate('/results', { q });
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.topbar-search')) closeSuggest();
  });

  $('#mobile-search').addEventListener('click', () => {
    document.body.classList.add('search-open');
    input.focus();
  });
  input.addEventListener('blur', () => {
    setTimeout(() => {
      if (!document.activeElement?.closest('.topbar-search')) {
        document.body.classList.remove('search-open');
      }
    }, 150);
  });

  // "/" focuses search, the way YouTube does.
  document.addEventListener('keydown', (e) => {
    if (e.key !== '/' || e.target.closest('input, textarea, [contenteditable="true"]')) return;
    e.preventDefault();
    input.focus();
    input.select();
  });

  // Keep the box in sync with the URL when navigating to a results page.
  routerEvents.on('after', (r) => {
    if (r.path === '/results') {
      input.value = r.query.q || '';
      clear.hidden = !input.value;
    }
  });
}

/* ---------- account button & sync badge ---------- */

function paintAccount() {
  const host = $('#account-slot');

  if (!isSignedIn() && auth.features.auth) {
    setChildren(host, el('button', {
      class: 'btn btn-primary signin-btn',
      onclick: () => promptSignIn(),
    }, svgIcon('subs', 18), el('span', {}, 'Sign in')));
    return;
  }

  const who = auth.user || store.user;
  const btn = el('button', {
    class: 'profile-btn',
    id: 'profile-btn',
    'aria-label': isSignedIn() ? `${who.name} — account menu` : 'Settings',
    'aria-haspopup': 'menu',
    title: isSignedIn() ? who.name : 'Settings',
    onclick: (e) => { e.stopPropagation(); openAccountMenu(btn); },
  }, avatar(who, 32));

  setChildren(host, btn);
}

function openAccountMenu(anchor) {
  closeAnyMenu();

  const who = auth.user || store.user;
  const items = [
    ...(isSignedIn()
      ? [{ label: 'Signed in as ' + who.email, icon: 'subs', disabled: true }]
      : []),
    { label: 'Settings', icon: 'settings', action: () => navigate('/settings') },
    { label: 'Your playlists', icon: 'library', action: () => navigate('/playlists') },
    { label: 'History', icon: 'history', action: () => navigate('/history') },
    ...(isAdmin() ? [{ label: 'Studio', icon: 'studio', action: () => navigate('/studio') }] : []),
    ...(isSignedIn()
      ? [{
          label: 'Sign out',
          icon: 'back',
          action: async () => {
            await signOut();
            toast('Signed out — your data stays on this device');
          },
        }]
      : auth.features.auth
        ? [{ label: 'Sign in', icon: 'subs', action: () => promptSignIn() }]
        : []),
  ];

  const menu = el('div', { class: 'popmenu', role: 'menu' },
    ...items.map((item) => el('button', {
      class: `popmenu-item${item.disabled ? ' is-static' : ''}`,
      role: 'menuitem',
      disabled: item.disabled || null,
      onclick: (e) => { e.stopPropagation(); closeAnyMenu(); item.action?.(); },
    }, svgIcon(item.icon, 20), el('span', {}, item.label))));

  document.body.append(menu);

  const rect = anchor.getBoundingClientRect();
  const box = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(rect.right - box.width, window.innerWidth - box.width - 8))}px`;
  menu.style.top = `${rect.bottom + 6}px`;

  menu.addEventListener('click', (e) => e.stopPropagation());
  registerOpenMenu(menu);
}

function paintSync(status) {
  const pill = $('#sync-pill');
  const labels = {
    off: null, idle: null,
    pending: 'Sync queued', saving: 'Syncing…', saved: 'Synced', error: 'Sync failed',
  };
  const label = labels[status.state];
  pill.hidden = !label;
  if (!label) return;
  pill.textContent = label;
  pill.dataset.state = status.state;
  pill.title = status.error || (status.lastSyncedAt ? `Last synced ${new Date(status.lastSyncedAt).toLocaleTimeString()}` : '');
  if (status.state === 'saved') setTimeout(() => { if (sync.status.state === 'saved') pill.hidden = true; }, 2500);
}

/* ---------- routes ---------- */

function registerRoutes() {
  route('/', homeView);
  route('/explore', (ctx) => homeView({ ...ctx, explore: true }));
  route('/watch', watchView);
  route('/channel/:handle', channelView);
  route('/series/:id', seriesView);
  route('/playlist/:id', playlistView);
  route('/results', searchView);
  route('/subscriptions', (ctx) => libraryView({ ...ctx, section: 'subscriptions' }));
  route('/history', (ctx) => libraryView({ ...ctx, section: 'history' }));
  route('/liked', (ctx) => libraryView({ ...ctx, section: 'liked' }));
  route('/watch-later', (ctx) => libraryView({ ...ctx, section: 'watchLater' }));
  route('/playlists', (ctx) => libraryView({ ...ctx, section: 'playlists' }));
  route('/studio', studioView);
  route('/settings', settingsView);
  route('*', () => {
    setView(emptyState('compass', 'This page doesn’t exist',
      'The link may be out of date, or the video was removed from the catalog.',
      button('Back to home', { variant: 'primary', onClick: () => navigate('/') })),
      { title: 'Not found' });
  });
}

/* ---------- service worker ---------- */

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  if (location.protocol === 'file:') return; // no SW on file:// — dev convenience
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch((err) => {
      console.warn('[sw] registration failed:', err.message);
    });
  });
}

/* ---------- boot ---------- */

async function boot() {
  loadLocal();
  applyTheme();
  paintProfile();
  buildSidebar();
  wireNav();
  wireSearch();
  registerRoutes();

  events.on('user', () => { paintProfile(); buildSidebar(); });
  events.on('settings', applyTheme);
  events.on('sync', paintSync);
  events.on('catalog', buildSidebar);
  routerEvents.on('before', runViewTeardowns);
  routerEvents.on('after', highlightNav);

  sync.start();
  startRouter();

  // The catalog arrives after first paint; views that rendered a skeleton get a
  // second pass once the data is in.
  try {
    await loadCatalog();
    if (store.loadError) toast(store.loadError, { duration: 6000 });
    resolve();
  } catch (err) {
    console.error('[boot] catalog load failed:', err);
    toast('Could not load the catalog.', { duration: 6000 });
  }

  registerServiceWorker();
}

boot();
