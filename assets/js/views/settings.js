// Settings: account, appearance, playback, shortcuts, data.

import { el } from '../util.js';
import { LS } from '../config.js';
import { auth, isSignedIn, promptSignIn, signOut, authEvents } from '../auth.js';
import { store, setSetting, setProfile, clearHistory, loadCatalog } from '../store.js';
import * as sync from '../sync.js';
import { button, toast, confirmDialog, svgIcon, avatar, sectionTitle } from '../components.js';
import { navigate } from '../router.js';
import { setView, applyTheme } from '../app.js';

export default function settingsView() {
  setView([
    el('div', { class: 'page-head' },
      el('h1', { class: 'page-title' }, 'Settings')),
    accountPanel(),
    profilePanel(),
    appearancePanel(),
    playbackPanel(),
    shortcutsPanel(),
    dataPanel(),
  ], { title: 'Settings' });
}

const rerender = () => settingsView();

function panel(title, sub, ...children) {
  return el('section', { class: 'panel' },
    el('h2', { class: 'panel-title' }, title),
    sub ? el('p', { class: 'panel-sub' }, sub) : null,
    ...children.filter(Boolean));
}

function toggleRow(label, hint, checked, onChange) {
  return el('div', { class: 'shortcut-row', style: { padding: '.5rem 0' } },
    el('div', {},
      el('div', { style: { fontWeight: '500' } }, label),
      hint ? el('div', { class: 'form-hint' }, hint) : null),
    el('span', { class: 'switch' },
      el('input', {
        type: 'checkbox', checked: checked || null, 'aria-label': label,
        onchange: (e) => onChange(e.target.checked),
      }),
      el('span', { class: 'switch-track' })));
}

/* ---------- account ---------- */

function accountPanel() {
  if (!auth.features.auth) {
    return panel('Account',
      'Accounts aren’t set up on this deployment, so everything stays on this device.',
      el('div', { class: 'banner' },
        svgIcon('settings', 20),
        el('div', {},
          el('div', { class: 'banner-title' }, 'Running without a backend'),
          el('div', { class: 'muted' },
            'Set AUTH_SECRET and GITHUB_TOKEN in the environment to enable sign-in and cross-device sync. '
            + 'See the README for the full list.'))));
  }

  if (!isSignedIn()) {
    return panel('Account',
      'Sign in to carry your subscriptions, history and playlists between devices.',
      el('div', { class: 'form-actions', style: { justifyContent: 'flex-start' } },
        button('Sign in', {
          variant: 'primary',
          onClick: () => promptSignIn().then((user) => { if (user) rerender(); }),
        }),
        button('Create an account', {
          variant: 'subtle',
          onClick: () => promptSignIn({ mode: 'signup' }).then((user) => { if (user) rerender(); }),
        })));
  }

  const syncLabel = {
    off: 'Not syncing', idle: 'Up to date', pending: 'Changes queued',
    saving: 'Syncing…', saved: 'Up to date', error: `Sync problem — ${sync.status.error || 'retrying'}`,
  }[sync.status.state] || '';

  return panel('Account', null,
    el('div', { class: 'account-row' },
      avatar({ name: auth.user.name, avatar: auth.user.avatar }, 56),
      el('div', { style: { flex: '1', minWidth: '0' } },
        el('div', { style: { fontWeight: '600' } }, auth.user.name),
        el('div', { class: 'muted', style: { fontSize: '.85rem' } }, auth.user.email),
        el('div', { class: 'form-hint' },
          [auth.user.provider === 'google' ? 'Signed in with Google' : 'Signed in with email',
           auth.user.isAdmin ? 'Administrator' : null,
           syncLabel].filter(Boolean).join(' · '))),
      button('Sign out', {
        variant: 'subtle',
        onClick: async () => {
          await signOut();
          toast('Signed out — your data stays on this device');
          rerender();
        },
      })),

    auth.user.isAdmin
      ? el('div', { class: 'form-actions', style: { justifyContent: 'flex-start' } },
          button('Open Studio', { variant: 'ghost', icon: 'studio', onClick: () => navigate('/studio') }))
      : null,

    toggleRow('Sync across devices',
      'Keeps subscriptions, history and playlists on your account.',
      store.settings.sync !== false,
      (on) => {
        setSetting('sync', on);
        if (on) sync.schedule('user');
        toast(on ? 'Sync on' : 'Sync off — changes stay on this device');
        rerender();
      }));
}

/* ---------- profile ---------- */

function profilePanel() {
  const name = el('input', { class: 'input', maxlength: '40', placeholder: 'Your display name' });
  name.value = (isSignedIn() ? auth.user.name : store.user.name) === 'Guest'
    ? '' : (isSignedIn() ? auth.user.name : store.user.name);

  const avatarUrl = el('input', { class: 'input', placeholder: 'https://…/you.jpg (optional)' });
  avatarUrl.value = store.user.avatar || auth.user?.avatar || '';

  return panel('Display name', 'Shown on your comments.',
    el('div', { class: 'form-grid' },
      el('div', { class: 'form-row' }, el('label', { class: 'form-label' }, 'Name'), name),
      el('div', { class: 'form-row' }, el('label', { class: 'form-label' }, 'Avatar URL'), avatarUrl)),
    el('div', { class: 'form-actions' },
      button('Save', {
        variant: 'primary',
        onClick: () => {
          setProfile({ name: name.value.trim() || 'Guest', avatar: avatarUrl.value.trim() || null });
          if (isSignedIn()) {
            auth.user.name = store.user.name;
            auth.user.avatar = store.user.avatar;
            authEvents.emit('change', auth.user);
            sync.schedule('user');
          }
          toast('Saved');
          rerender();
        },
      })));
}

/* ---------- appearance ---------- */

function appearancePanel() {
  const options = [['dark', 'Dark'], ['light', 'Light'], ['system', 'Match system']];
  return panel('Appearance', null,
    el('div', { class: 'chipbar', style: { position: 'static', paddingBottom: 0 } },
      ...options.map(([value, label]) => el('button', {
        class: `chip${store.settings.theme === value ? ' is-active' : ''}`,
        onclick: () => { setSetting('theme', value); applyTheme(); rerender(); },
      }, label))));
}

/* ---------- playback ---------- */

function playbackPanel() {
  const rates = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
  return panel('Playback', null,
    toggleRow('Autoplay the next title', 'Plays the next episode or recommendation when one finishes.',
      store.settings.autoplay, (on) => setSetting('autoplay', on)),
    el('div', { class: 'form-row', style: { marginTop: '.75rem' } },
      el('label', { class: 'form-label' }, 'Default speed'),
      el('div', { class: 'chipbar', style: { position: 'static', paddingBottom: 0 } },
        ...rates.map((r) => el('button', {
          class: `chip${store.settings.rate === r ? ' is-active' : ''}`,
          onclick: () => { setSetting('rate', r); rerender(); },
        }, r === 1 ? 'Normal' : `${r}x`)))),
    el('div', { class: 'form-row', style: { marginTop: '1rem' } },
      el('label', { class: 'form-label' }, `Default volume — ${Math.round(store.settings.volume * 100)}%`),
      el('input', {
        type: 'range', min: '0', max: '1', step: '0.05',
        value: String(store.settings.volume),
        'aria-label': 'Default volume',
        oninput: (e) => setSetting('volume', Number(e.target.value)),
        onchange: rerender,
      })));
}

/* ---------- shortcuts ---------- */

function shortcutsPanel() {
  const rows = [
    ['Play / pause', ['k', 'Space']],
    ['Back / forward 10s', ['j', 'l']],
    ['Back / forward 5s', ['←', '→']],
    ['Volume', ['↑', '↓']],
    ['Mute', ['m']],
    ['Full screen', ['f']],
    ['Theater mode', ['t']],
    ['Miniplayer', ['i']],
    ['Subtitles', ['c']],
    ['Next video', ['n']],
    ['Speed down / up', [',', '.']],
    ['Jump to 0–90%', ['0', '…', '9']],
    ['Focus search', ['/']],
  ];
  return panel('Keyboard shortcuts', null,
    el('div', { class: 'shortcut-list' },
      ...rows.map(([label, keys]) => el('div', { class: 'shortcut-row' },
        el('span', {}, label),
        el('span', { style: { display: 'flex', gap: '.25rem' } },
          ...keys.map((k) => el('span', { class: 'kbd' }, k)))))));
}

/* ---------- data ---------- */

function dataPanel() {
  const counts = [
    `${store.user.history.length} history entries`,
    `${store.user.subscriptions.length} subscriptions`,
    `${store.user.playlists.length} playlists`,
    `${store.user.watchLater.length} saved for later`,
  ].join(' · ');

  return panel('Your data', counts,
    el('div', { class: 'form-actions', style: { justifyContent: 'flex-start', flexWrap: 'wrap' } },
      button('Export as JSON', {
        variant: 'subtle',
        onClick: () => {
          const blob = new Blob([JSON.stringify(store.user, null, 2)], { type: 'application/json' });
          const url = URL.createObjectURL(blob);
          const a = el('a', { href: url, download: `youtubementries-${store.user.id}.json` });
          document.body.append(a);
          a.click();
          a.remove();
          URL.revokeObjectURL(url);
        },
      }),
      button('Clear watch history', {
        variant: 'subtle',
        onClick: async () => {
          const ok = await confirmDialog('Clear watch history?',
            'Removes every entry and all resume positions.'
            + (isSignedIn() ? ' This syncs to your account.' : ''),
            { confirmLabel: 'Clear history' });
          if (!ok) return;
          clearHistory();
          toast('Watch history cleared');
          rerender();
        },
      }),
      button('Reset this device', {
        variant: 'danger', icon: 'trash',
        onClick: async () => {
          const ok = await confirmDialog('Reset this device?',
            'Clears the local copy of your profile, history, playlists and cached catalog. '
            + (isSignedIn()
              ? 'Your account keeps its synced copy — signing in again restores it.'
              : 'Nothing is synced, so this cannot be undone.'),
            { confirmLabel: 'Reset' });
          if (!ok) return;
          for (const key of Object.values(LS)) {
            if (typeof key === 'string') localStorage.removeItem(key);
          }
          location.hash = '#/';
          location.reload();
        },
      })),

    el('div', { style: { marginTop: '1.5rem' } },
      sectionTitle('Catalog'),
      el('p', { class: 'form-hint' },
        `${store.catalog.videos.length} videos · ${store.catalog.channels.length} channels · `
        + `${store.catalog.series.length} series · ${store.catalog.playlists.length} playlists`),
      el('div', { class: 'form-actions', style: { justifyContent: 'flex-start' } },
        button('Refresh catalog', {
          variant: 'subtle',
          onClick: async () => {
            await loadCatalog({ fresh: true });
            toast('Catalog refreshed');
            rerender();
          },
        }))));
}
