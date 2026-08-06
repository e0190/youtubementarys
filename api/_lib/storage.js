// Storage facade.
//
// Everything that persists data goes through here rather than talking to a
// backend directly. In production that backend is the GitHub Contents API,
// authenticated with GITHUB_TOKEN from the environment. Locally it can be the
// filesystem, so the app runs end to end without credentials.

import * as github from './github.js';
import * as local from './local.js';

const driver = () => (local.isConfigured() ? local : github);

export const backend = () => (local.isConfigured() ? 'filesystem' : 'github');

export const isConfigured = () => local.isConfigured() || github.isConfigured();

export const readJSON = (path, opts) => driver().readJSON(path, opts);
export const writeJSON = (path, data, opts) => driver().writeJSON(path, data, opts);
export const updateJSON = (path, mutate, opts) => driver().updateJSON(path, mutate, opts);
export const deleteFile = (path, message) => driver().deleteFile(path, message);
export const invalidate = (path) => driver().invalidate(path);
