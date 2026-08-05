// Settings: profile, appearance, playback, GitHub sync, data management.

import { el, lsGet } from '../util.js';
import { LS, REPO } from '../config.js';
import { setToken, verifyToken, rateLimit, hasToken } from '../github.js';
import { store, setSetting, setProfile, clearHistory, loadCatalog } from '../store.js';
import * as sync from '../sync.js';
import {
  button, toast, confirmDialog, svgIcon, avatar, sectionTitle,
} from '../components.js';
import { navigate } from '../router.js';
import { setView, applyTheme } from '../app.js';

export default function settingsView() {
  setView([
    el('div', { class: 'page-head' },
      el('h1', { class: 'page-title' }, 'Settings'),
      el('p', { class: 'page-sub' }, 'Everything here is stored on this device unless sync is on.')),
    profilePanel(),
    appearancePanel(),
    playbackPanel(),
    syncPanel(),
    shortcutsPanel(),
    dataPanel(),
  ], { title: 'Settings' });
}

const rerender = () => settingsView();

function panel(title, sub, ...children) {
  return el('section', { class: 'panel' },
    el('h2', { class: 'panel-title' }, title),
    sub ? el('p', { class: 'panel-sub' }, sub) : null,
    ...children);
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

/* ---------- profile ---------- */

function profilePanel() {
  const name = el('input', { class: 'input', maxlength: '40', placeholder: 'Your display name' });
  name.value = store.user.name === 'Guest' ? '' : store.user.name;
  const avatarUrl = el('input', { class: 'input', placeholder: 'https://…/you.jpg (optional)' });
  avatarUrl.value = store.user.avatar || '';

  const preview = el('div', { style: { display: 'flex', alignItems: 'center', gap: '.75rem', marginBottom: '1rem' } },
    avatar(store.user, 56),
    el('div', {},
      el('div', { style: { fontWeight: '600' } }, store.user.name),
      el('div', { class: 'form-hint' }, `Profile id ${store.user.id}`)));

  return panel('Profile', 'Used on comments and the account button.',
    preview,
    el('div', { class: 'form-grid' },
      el('div', { class: 'form-row' }, el('label', { class: 'form-label' }, 'Display name'), name),
      el('div', { class: 'form-row' }, el('label', { class: 'form-label' }, 'Avatar URL'), avatarUrl)),
    el('div', { class: 'form-actions' },
      button('Save profile', {
        variant: 'primary',
        onClick: () => {
          setProfile({ name: name.value.trim() || 'Guest', avatar: avatarUrl.value.trim() || null });
          toast('Profile saved');
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
        onclick: () => {
          setSetting('theme', value);
          applyTheme();
          rerender();
        },
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

/* ---------- GitHub sync ---------- */

function syncPanel() {
  const tokenInput = el('input', {
    class: 'input', type: 'password', placeholder: 'github_pat_… or ghp_…',
    autocomplete: 'off', spellcheck: 'false',
  });
  const statusLine = el('div', { class: 'form-hint', style: { marginTop: '.5rem' } });
  const stored = lsGet(LS.token, '');
  const bakedIn = Boolean(REPO.token);

  if (stored) {
    statusLine.textContent = `A token is saved on this device (…${String(stored).slice(-4)}).`;
  } else if (bakedIn) {
    statusLine.textContent = 'Using the token shipped in config.js.';
  } else {
    statusLine.textContent = 'No token — the site is read-only and your data stays on this device.';
  }

  const check = async () => {
    statusLine.textContent = 'Checking…';
    const result = await verifyToken();
    if (!result.ok) { statusLine.textContent = `✕ ${result.reason}`; return; }
    const limit = await rateLimit();
    statusLine.textContent = `✓ Write access to ${result.repo}`
      + (limit ? ` · ${limit.remaining}/${limit.limit} API calls left this hour` : '');
  };

  return panel('GitHub sync',
    'A token lets this device publish catalog edits and back up your history, subscriptions and playlists to the repo.',

    bakedIn
      ? el('div', { class: 'banner banner-danger' },
          svgIcon('settings', 20),
          el('div', {},
            el('div', { class: 'banner-title' }, 'A token is hard-coded in config.js'),
            el('div', {}, 'It ships to every visitor of this site and can be read straight out of the page source. '
              + 'Remove it before making the repo or the site public, and let people paste their own instead.')))
      : null,

    el('div', { class: 'form-grid' },
      el('div', { class: 'form-row' },
        el('label', { class: 'form-label' }, 'Personal access token'),
        tokenInput,
        el('div', { class: 'form-hint' },
          'Fine-grained token scoped to this repo with Contents: Read and write. Stored in this browser only.')),
      statusLine),

    el('div', { class: 'form-actions' },
      hasToken()
        ? button('Sign out', {
            variant: 'ghost',
            onClick: () => {
              setToken('');
              toast('Token removed from this device');
              rerender();
            },
          })
        : null,
      hasToken() ? button('Test access', { variant: 'subtle', onClick: check }) : null,
      button('Save token', {
        variant: 'primary',
        onClick: async () => {
          const value = tokenInput.value.trim();
          if (!value) { tokenInput.focus(); return; }
          setToken(value);
          const result = await verifyToken(value);
          if (!result.ok) {
            statusLine.textContent = `✕ ${result.reason}`;
            toast(result.reason, { duration: 6000 });
            return;
          }
          tokenInput.value = '';
          toast(`Connected to ${result.repo}`);
          await sync.pullUser();
          await loadCatalog({ fresh: true });
          rerender();
        },
      })),

    el('div', { style: { marginTop: '1rem' } },
      toggleRow('Back up my data to the repo',
        'Writes subscriptions, history and playlists to data/users/ when a token is set.',
        store.settings.sync, (on) => {
          setSetting('sync', on);
          if (on) sync.schedule('user');
          toast(on ? 'Sync on' : 'Sync off — data stays on this device');
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
            'Removes every entry and all resume positions on this device.',
            { confirmLabel: 'Clear history' });
          if (!ok) return;
          clearHistory();
          toast('Watch history cleared');
          rerender();
        },
      }),
      button('Reset everything', {
        variant: 'danger', icon: 'trash',
        onClick: async () => {
          const ok = await confirmDialog('Reset this device?',
            'Deletes your profile, subscriptions, history, playlists, saved token and cached catalog from this browser. '
            + 'Anything already synced to the repo stays there.',
            { confirmLabel: 'Reset everything' });
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
        button('Refresh from GitHub', {
          variant: 'subtle',
          onClick: async () => {
            await loadCatalog({ fresh: true });
            toast('Catalog refreshed');
            rerender();
          },
        }),
        button('Open Studio', { variant: 'ghost', onClick: () => navigate('/studio') }))));
}
