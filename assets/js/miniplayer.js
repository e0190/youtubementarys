// Floating miniplayer.
//
// Leaving the watch page while something is playing hands the video off to a
// small persistent window, so browsing doesn't stop playback. Clicking the title
// returns to the full watch page at the same position.

import { $, el } from './util.js';
import { createPlayer, ICONS, icon } from './player.js';
import { recordProgress, getVideo, store } from './store.js';
import { navigate } from './router.js';

const host = $('#miniplayer');
let active = null; // { videoId, player, saveTimer }

export const miniplayerVideoId = () => active?.videoId || null;

/** Move playback into the floating window. */
export function openMiniplayer(video, { startAt = 0, playing = true } = {}) {
  if (!video) return;
  closeMiniplayer();

  const stageHost = el('div', { class: 'mini-stage' });
  const titleLink = el('button', {
    class: 'mini-title',
    title: video.title,
    onclick: () => {
      const at = Math.floor(player.getTime());
      closeMiniplayer();
      navigate('/watch', { v: video.id, t: at || null });
    },
  }, video.title);

  const closeBtn = el('button', { class: 'icon-btn', 'aria-label': 'Close miniplayer' }, icon(ICONS.close, { size: 20 }));
  closeBtn.addEventListener('click', () => closeMiniplayer());

  host.replaceChildren(stageHost, el('div', { class: 'mini-bar' }, titleLink, closeBtn));
  host.hidden = false;

  const player = createPlayer(stageHost, video, {
    startAt,
    autoplay: playing,
    volume: store.settings.volume,
    muted: store.settings.muted,
    rate: store.settings.rate,
    // Shortcuts stay with the page, not the floating window — otherwise space
    // would pause the corner video instead of scrolling.
    keyboard: false,
  });

  // Persist the resume point on the same cadence as the watch page.
  const saveTimer = setInterval(() => {
    const t = player.getTime();
    if (t > 0) recordProgress(video.id, t, player.getDuration());
  }, 5000);

  player.on('miniplayer', () => {
    const at = Math.floor(player.getTime());
    closeMiniplayer();
    navigate('/watch', { v: video.id, t: at || null });
  });
  player.on('ended', () => closeMiniplayer());

  active = { videoId: video.id, player, saveTimer };
}

/**
 * Tear down the miniplayer.
 * Pass a video id to close it only when it is showing that video — used when
 * navigating to the watch page for the same title.
 */
export function closeMiniplayer(onlyIfVideoId = undefined) {
  if (!active) return;
  if (onlyIfVideoId !== undefined && active.videoId !== onlyIfVideoId) return;

  clearInterval(active.saveTimer);
  const t = active.player.getTime();
  if (t > 0) recordProgress(active.videoId, t, active.player.getDuration());
  active.player.destroy();
  active = null;
  host.hidden = true;
  host.replaceChildren();
}

/** Where the miniplayer had reached, if it was showing this video. */
export function handoffPosition(videoId) {
  if (active?.videoId !== videoId) return null;
  return Math.floor(active.player.getTime());
}

export const miniplayerVideo = () => (active ? getVideo(active.videoId) : null);
