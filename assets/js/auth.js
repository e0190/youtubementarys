// Sign-in state and UI.
//
// Signed out, the app still works completely — data just stays on the device.
// Signing in adopts that local data and starts syncing it. That's deliberate:
// nobody should hit a login wall before they can watch anything.

import { el, emitter, lsSet } from './util.js';
import { api, ApiError } from './api.js';
import { LS } from './config.js';

export const authEvents = emitter();

export const auth = {
  user: null,          // { id, email, name, isAdmin } when signed in
  features: {          // what this deployment actually has configured
    auth: false, google: false, storage: false, youtubeSearch: false,
  },
  ready: false,
};

export const isSignedIn = () => Boolean(auth.user);
export const isAdmin = () => Boolean(auth.user?.isAdmin);

/** Ask the server who we are. Safe to call before anything else. */
export async function loadSession() {
  try {
    const data = await api.session();
    auth.user = data.user || null;
    auth.features = { ...auth.features, ...(data.features || {}) };
  } catch {
    // A static deploy with no functions, or the network is down. Guest mode.
    auth.user = null;
    auth.features = { auth: false, google: false, storage: false, youtubeSearch: false };
  }
  auth.ready = true;
  authEvents.emit('change', auth.user);
  return auth.user;
}

export async function signOut() {
  try { await api.logout(); } catch { /* clearing local state matters more */ }
  auth.user = null;
  // Keep the cached catalog, drop the identity.
  lsSet(LS.user, null);
  authEvents.emit('change', null);
  authEvents.emit('signout');
}

/* ---------- sign-in dialog ---------- */

let openDialog = null;

/**
 * Show the sign-in dialog.
 * Resolves with the signed-in user, or null if it was dismissed.
 */
export function promptSignIn({ mode = 'signin', reason = null } = {}) {
  if (openDialog) return openDialog.promise;

  let resolve;
  const promise = new Promise((r) => { resolve = r; });

  const backdrop = el('div', { class: 'modal-backdrop auth-backdrop' });
  const dialog = el('div', {
    class: 'modal auth-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Sign in',
  });
  backdrop.append(dialog);

  let current = mode;

  const close = (user = null) => {
    backdrop.classList.remove('is-in');
    setTimeout(() => backdrop.remove(), 180);
    document.removeEventListener('keydown', onKey);
    openDialog = null;
    resolve(user);
  };
  const onKey = (e) => { if (e.key === 'Escape') close(null); };

  function paint() {
    const signup = current === 'signup';

    const errorBox = el('div', { class: 'form-error', hidden: true });
    const email = el('input', {
      class: 'input', type: 'email', placeholder: 'you@example.com',
      autocomplete: 'email', required: true,
    });
    const password = el('input', {
      class: 'input', type: 'password', placeholder: signup ? 'At least 8 characters' : 'Your password',
      autocomplete: signup ? 'new-password' : 'current-password', required: true,
    });
    const name = el('input', {
      class: 'input', placeholder: 'What should we call you?', autocomplete: 'name', maxlength: '40',
    });

    const submit = el('button', { class: 'btn btn-primary auth-submit', type: 'submit' },
      el('span', {}, signup ? 'Create account' : 'Sign in'));

    const fail = (message) => {
      errorBox.textContent = message;
      errorBox.hidden = false;
      submit.disabled = false;
      submit.replaceChildren(el('span', {}, signup ? 'Create account' : 'Sign in'));
    };

    const form = el('form', {
      class: 'auth-form',
      onsubmit: async (e) => {
        e.preventDefault();
        errorBox.hidden = true;
        submit.disabled = true;
        submit.replaceChildren(el('span', {}, signup ? 'Creating…' : 'Signing in…'));
        try {
          const result = signup
            ? await api.register(email.value.trim(), password.value, name.value.trim())
            : await api.login(email.value.trim(), password.value);
          auth.user = result.user;
          authEvents.emit('change', auth.user);
          authEvents.emit('signin', auth.user);
          close(auth.user);
        } catch (err) {
          fail(err instanceof ApiError ? err.message : 'Something went wrong. Try again.');
        }
      },
    },
      errorBox,
      signup ? field('Name', name) : null,
      field('Email', email),
      field('Password', password),
      submit);

    const googleBtn = auth.features.google
      ? el('a', {
          class: 'btn btn-google',
          href: api.googleSignInUrl(location.hash || '#/'),
        }, googleMark(), el('span', {}, 'Continue with Google'))
      : null;

    dialog.replaceChildren(
      el('div', { class: 'auth-head' },
        el('h2', { class: 'modal-title' }, signup ? 'Create your account' : 'Sign in'),
        el('p', { class: 'auth-sub' },
          reason
          || (signup
            ? 'Your subscriptions, history and playlists follow you to any device.'
            : 'Welcome back.'))),

      el('div', { class: 'auth-body' },
        googleBtn,
        googleBtn ? el('div', { class: 'auth-divider' }, el('span', {}, 'or')) : null,
        form,
        el('p', { class: 'auth-switch' },
          signup ? 'Already have an account? ' : 'New here? ',
          el('button', {
            type: 'button', class: 'linklike',
            onclick: () => { current = signup ? 'signin' : 'signup'; paint(); },
          }, signup ? 'Sign in' : 'Create an account')),
        el('p', { class: 'auth-guest' },
          el('button', { type: 'button', class: 'linklike', onclick: () => close(null) },
            'Keep browsing without an account'))));

    dialog.querySelector('input')?.focus();
  }

  const field = (label, control) =>
    el('label', { class: 'form-row' }, el('span', { class: 'form-label' }, label), control);

  paint();

  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(null); });
  document.addEventListener('keydown', onKey);
  document.body.append(backdrop);
  requestAnimationFrame(() => backdrop.classList.add('is-in'));

  openDialog = { promise, close };
  return promise;
}

/**
 * Run `action` only when signed in, prompting first if needed.
 * Returns false when the person dismissed the prompt.
 */
export async function withSignIn(reason, action) {
  if (isSignedIn()) { await action(); return true; }
  if (!auth.features.auth) {
    // Nothing to sign in to on this deployment — let the action run locally.
    await action();
    return true;
  }
  const user = await promptSignIn({ reason });
  if (!user) return false;
  await action();
  return true;
}

function googleMark() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 18 18');
  svg.setAttribute('width', '18');
  svg.setAttribute('height', '18');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = `
    <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.91c1.7-1.57 2.69-3.88 2.69-6.62z"/>
    <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.91-2.26c-.81.54-1.84.86-3.05.86-2.34 0-4.33-1.58-5.04-3.71H.96v2.33A9 9 0 0 0 9 18z"/>
    <path fill="#FBBC05" d="M3.96 10.71a5.41 5.41 0 0 1 0-3.42V4.96H.96a9 9 0 0 0 0 8.08l3-2.33z"/>
    <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.46.89 11.43 0 9 0A9 9 0 0 0 .96 4.96l3 2.33C4.67 5.16 6.66 3.58 9 3.58z"/>`;
  return svg;
}

/** Read ?auth=… left behind by the OAuth redirect, then clean the URL. */
export function consumeAuthRedirect() {
  const hash = location.hash || '';
  const qIndex = hash.indexOf('?');
  if (qIndex < 0) return null;
  const params = new URLSearchParams(hash.slice(qIndex + 1));
  const status = params.get('auth');
  if (!status) return null;

  params.delete('auth');
  const rest = params.toString();
  history.replaceState(null, '', `${hash.slice(0, qIndex)}${rest ? `?${rest}` : ''}` || '#/');
  return status;
}
