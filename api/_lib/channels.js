// Every account owns exactly one channel, created the first time it's needed.
//
// A channel id is derived from the account id, so ownership is decidable
// without a lookup: `ch_<userId>` belongs to `<userId>` and nobody else. That
// property is what lets the catalog endpoint authorise writes cheaply.

import { readJSON, updateJSON } from './storage.js';

const PATH = 'data/channels.json';

export const channelIdFor = (userId) => `ch_${userId}`;

export const ownsChannel = (session, channelId) =>
  Boolean(session?.sub) && channelId === channelIdFor(session.sub);

function handleFrom(name, email, userId) {
  const base = String(name || email?.split('@')[0] || 'viewer')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 24);
  // Suffix keeps handles unique without a second round-trip to check.
  return `${base || 'viewer'}${userId.replace(/[^a-z0-9]/gi, '').slice(-4).toLowerCase()}`;
}

/**
 * Return the account's channel, creating it if this is their first upload.
 * Safe to call concurrently — the write is a read-modify-write with retries and
 * re-checks for an existing record inside the transaction.
 */
export async function ensureChannel(session, { name, avatar } = {}) {
  const id = channelIdFor(session.sub);

  const { data } = await readJSON(PATH);
  const existing = (data?.channels || []).find((c) => c.id === id);
  if (existing) return existing;

  const record = {
    id,
    handle: handleFrom(name || session.name, session.email, session.sub),
    name: name || session.name || 'Viewer',
    tagline: '',
    description: '',
    avatar: avatar || null,
    banner: null,
    verified: false,
    subscribers: 0,
    joined: new Date().toISOString().slice(0, 10),
    topics: [],
    links: [],
    ownerId: session.sub,
  };

  let created = record;
  await updateJSON(PATH, (current) => {
    const channels = current?.channels || [];
    const already = channels.find((c) => c.id === id);
    if (already) { created = already; return undefined; }
    return { ...(current || {}), channels: [...channels, record] };
  }, { message: `channel: create for ${session.email || session.sub}`, fallback: { channels: [] } });

  return created;
}

/** Update the parts of a channel its owner is allowed to change. */
export async function updateOwnChannel(session, patch) {
  const id = channelIdFor(session.sub);
  let updated = null;

  await updateJSON(PATH, (current) => {
    const channels = current?.channels || [];
    const i = channels.findIndex((c) => c.id === id);
    if (i < 0) return undefined;
    const next = channels.slice();
    next[i] = {
      ...next[i],
      // Deliberately narrow: nobody promotes themselves to verified, and
      // subscriber counts aren't self-declared.
      name: patch.name ?? next[i].name,
      tagline: patch.tagline ?? next[i].tagline,
      description: patch.description ?? next[i].description,
      avatar: patch.avatar !== undefined ? patch.avatar : next[i].avatar,
      banner: patch.banner !== undefined ? patch.banner : next[i].banner,
      topics: patch.topics ?? next[i].topics,
      links: patch.links ?? next[i].links,
    };
    updated = next[i];
    return { ...(current || {}), channels: next };
  }, { message: `channel: update ${id}`, fallback: { channels: [] } });

  return updated;
}
