// One player, two engines.
//
// A video's `source.type` decides whether playback runs through the YouTube
// IFrame API or a native <video> element. Both are wrapped in the same
// interface (play/pause/seek/…) and the same custom control bar, so the rest of
// the app never has to care which one it got.

import { el, $, timecode, clamp, emitter, throttle } from './util.js';

/* ---------- YouTube IFrame API loader ---------- */

let ytReady = null;

function loadYouTubeAPI() {
  if (ytReady) return ytReady;
  ytReady = new Promise((resolve, reject) => {
    if (window.YT?.Player) return resolve(window.YT);

    // The API calls this global exactly once when it finishes loading.
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      if (typeof previous === 'function') previous();
      resolve(window.YT);
    };

    if (!document.querySelector('script[data-yt-api]')) {
      const script = el('script', { src: 'https://www.youtube.com/iframe_api', async: true });
      script.dataset.ytApi = '1';
      script.onerror = () => reject(new Error('Could not load the YouTube player.'));
      document.head.append(script);
    }
    setTimeout(() => reject(new Error('The YouTube player timed out.')), 15000);
  });
  return ytReady;
}

/* ---------- engines ---------- */

/** Common surface: play, pause, seek, time, duration, volume, rate, destroy. */
class Engine {
  constructor(bus) { this.bus = bus; this.destroyed = false; }
  play() {} pause() {} seek() {} destroy() {}
  getTime() { return 0; }
  getDuration() { return 0; }
  getBuffered() { return 0; }
  setVolume() {} setMuted() {} setRate() {}
  get rates() { return [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]; }
  get hasCaptions() { return false; }
  setCaptions() {}
}

class YouTubeEngine extends Engine {
  constructor(bus, mountEl, { youtubeId, startAt = 0, autoplay = false }) {
    super(bus);
    this.mountEl = mountEl;
    this.pollTimer = null;
    this.captionsOn = true;
    this.ready = false;

    const host = el('div', { class: 'yt-host' });
    mountEl.append(host);

    loadYouTubeAPI().then((YT) => {
      if (this.destroyed) return;
      this.yt = new YT.Player(host, {
        videoId: youtubeId,
        playerVars: {
          autoplay: autoplay ? 1 : 0,
          start: Math.floor(startAt) || 0,
          controls: 0,        // we draw our own
          modestbranding: 1,
          rel: 0,
          playsinline: 1,
          iv_load_policy: 3,  // no annotation overlays
          disablekb: 1,       // our keyboard handler owns shortcuts
          origin: location.origin,
        },
        events: {
          onReady: () => {
            if (this.destroyed) return;
            this.ready = true;
            this.startPolling();
            bus.emit('ready');
            bus.emit('durationchange', this.getDuration());
          },
          onStateChange: (e) => {
            const S = window.YT.PlayerState;
            if (e.data === S.PLAYING) { bus.emit('play'); bus.emit('durationchange', this.getDuration()); }
            else if (e.data === S.PAUSED) bus.emit('pause');
            else if (e.data === S.ENDED) bus.emit('ended');
            else if (e.data === S.BUFFERING) bus.emit('waiting');
          },
          onPlaybackRateChange: (e) => bus.emit('ratechange', e.data),
          onError: (e) => bus.emit('error', youtubeErrorMessage(e.data)),
        },
      });
    }).catch((err) => bus.emit('error', err.message));
  }

  startPolling() {
    clearInterval(this.pollTimer);
    // The IFrame API has no timeupdate event, so we sample instead.
    this.pollTimer = setInterval(() => {
      if (this.destroyed || !this.ready) return;
      this.bus.emit('timeupdate', this.getTime(), this.getDuration());
    }, 250);
  }

  play() { this.yt?.playVideo?.(); }
  pause() { this.yt?.pauseVideo?.(); }
  seek(t) { this.yt?.seekTo?.(Math.max(0, t), true); this.bus.emit('timeupdate', t, this.getDuration()); }
  getTime() { return this.ready ? this.yt?.getCurrentTime?.() || 0 : 0; }
  getDuration() { return this.ready ? this.yt?.getDuration?.() || 0 : 0; }
  getBuffered() { return this.ready ? this.yt?.getVideoLoadedFraction?.() || 0 : 0; }
  setVolume(v) { this.yt?.setVolume?.(Math.round(clamp(v, 0, 1) * 100)); }
  setMuted(m) { m ? this.yt?.mute?.() : this.yt?.unMute?.(); }
  setRate(r) { this.yt?.setPlaybackRate?.(r); }

  get rates() { return this.yt?.getAvailablePlaybackRates?.() || super.rates; }
  get hasCaptions() { return true; }

  setCaptions(on) {
    this.captionsOn = on;
    // loadModule/unloadModule is the only supported captions toggle on the
    // IFrame API; it is undocumented but stable and widely relied on.
    try { on ? this.yt?.loadModule?.('captions') : this.yt?.unloadModule?.('captions'); } catch { /* ignore */ }
  }

  destroy() {
    this.destroyed = true;
    clearInterval(this.pollTimer);
    try { this.yt?.destroy?.(); } catch { /* already gone */ }
    this.mountEl.replaceChildren();
  }
}

function youtubeErrorMessage(code) {
  return {
    2: 'That YouTube video id looks malformed.',
    5: 'This video can’t play in the HTML5 player.',
    100: 'That video was removed or made private on YouTube.',
    101: 'The uploader disabled embedding for this video.',
    150: 'The uploader disabled embedding for this video.',
  }[code] || `YouTube playback error (${code}).`;
}

class FileEngine extends Engine {
  constructor(bus, mountEl, { src, poster, captions = [], startAt = 0, autoplay = false }) {
    super(bus);
    this.mountEl = mountEl;

    this.video = el('video', {
      class: 'file-video',
      playsinline: true,
      preload: 'metadata',
      poster: poster || null,
      crossorigin: captions.length ? 'anonymous' : null,
    });
    this.video.src = src;

    for (const [i, track] of captions.entries()) {
      const el_ = el('track', {
        kind: track.kind || 'subtitles',
        label: track.label || track.lang || `Track ${i + 1}`,
        srclang: track.lang || 'en',
        src: track.src,
      });
      if (i === 0) el_.default = true;
      this.video.append(el_);
    }
    this._hasCaptions = captions.length > 0;

    const v = this.video;
    v.addEventListener('loadedmetadata', () => {
      if (startAt > 0 && startAt < v.duration) v.currentTime = startAt;
      bus.emit('ready');
      bus.emit('durationchange', v.duration);
      if (autoplay) v.play().catch(() => bus.emit('blocked'));
    });
    v.addEventListener('play', () => bus.emit('play'));
    v.addEventListener('pause', () => bus.emit('pause'));
    v.addEventListener('ended', () => bus.emit('ended'));
    v.addEventListener('waiting', () => bus.emit('waiting'));
    v.addEventListener('ratechange', () => bus.emit('ratechange', v.playbackRate));
    v.addEventListener('timeupdate', () => bus.emit('timeupdate', v.currentTime, v.duration));
    v.addEventListener('error', () => {
      const codes = { 1: 'Playback was aborted.', 2: 'A network error interrupted the download.', 3: 'This file could not be decoded.', 4: 'This video format isn’t supported, or the file is missing.' };
      bus.emit('error', codes[v.error?.code] || 'This video could not be played.');
    });

    mountEl.append(v);
  }

  play() { return this.video.play().catch(() => this.bus.emit('blocked')); }
  pause() { this.video.pause(); }
  seek(t) { this.video.currentTime = Math.max(0, t); }
  getTime() { return this.video.currentTime || 0; }
  getDuration() { return Number.isFinite(this.video.duration) ? this.video.duration : 0; }

  getBuffered() {
    const b = this.video.buffered;
    if (!b.length || !this.getDuration()) return 0;
    return b.end(b.length - 1) / this.getDuration();
  }

  setVolume(v) { this.video.volume = clamp(v, 0, 1); }
  setMuted(m) { this.video.muted = m; }
  setRate(r) { this.video.playbackRate = r; }

  get hasCaptions() { return this._hasCaptions; }

  setCaptions(on) {
    for (const track of this.video.textTracks) track.mode = on ? 'showing' : 'disabled';
  }

  destroy() {
    this.destroyed = true;
    this.video.pause();
    this.video.removeAttribute('src');
    this.video.load();
    this.mountEl.replaceChildren();
  }
}

/* ---------- controls + public player ---------- */

const icon = (paths, { size = 24 } = {}) => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = paths;
  return svg;
};

const ICONS = {
  play: '<path fill="currentColor" d="M8 5v14l11-7z"/>',
  pause: '<path fill="currentColor" d="M6 5h4v14H6zm8 0h4v14h-4z"/>',
  replay: '<path fill="currentColor" d="M12 5V1L7 6l5 5V7a6 6 0 1 1-6 6H4a8 8 0 1 0 8-8z"/>',
  next: '<path fill="currentColor" d="M6 5l8.5 7L6 19V5zm10 0h2v14h-2z"/>',
  volHigh: '<path fill="currentColor" d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 7.97v8.05A4.47 4.47 0 0 0 16.5 12zM14 3.23v2.06a6.99 6.99 0 0 1 0 13.42v2.06a9 9 0 0 0 0-17.54z"/>',
  volLow: '<path fill="currentColor" d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 7.97v8.05A4.47 4.47 0 0 0 16.5 12z"/>',
  volMute: '<path fill="currentColor" d="M16.5 12A4.5 4.5 0 0 0 14 7.97v2.21l2.45 2.45c.03-.2.05-.41.05-.63zM19 12c0 .94-.2 1.82-.54 2.64l1.51 1.51A8.8 8.8 0 0 0 21 12a9 9 0 0 0-7-8.77v2.06A7 7 0 0 1 19 12zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06a9 9 0 0 0 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/>',
  cc: '<path fill="currentColor" d="M19 4H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2zm-8 7H9.5v-.5h-2v3h2V13H11v1a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1zm7 0h-1.5v-.5h-2v3h2V13H18v1a1 1 0 0 1-1 1h-3a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1z"/>',
  settings: '<path fill="currentColor" d="M19.14 12.94a7.07 7.07 0 0 0 0-1.88l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.6-.22l-2.39.96a7 7 0 0 0-1.62-.94l-.36-2.54a.5.5 0 0 0-.5-.42h-3.84a.5.5 0 0 0-.5.42l-.36 2.54c-.59.24-1.13.56-1.62.94l-2.39-.96a.5.5 0 0 0-.6.22L2.71 8.84a.5.5 0 0 0 .12.64l2.03 1.58a7.07 7.07 0 0 0 0 1.88l-2.03 1.58a.5.5 0 0 0-.12.64l1.92 3.32c.13.22.39.3.6.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.04.24.25.42.5.42h3.84c.25 0 .46-.18.5-.42l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .6-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.03-1.58zM12 15.5A3.5 3.5 0 1 1 12 8.5a3.5 3.5 0 0 1 0 7z"/>',
  theater: '<path fill="currentColor" d="M3 6h18v12H3V6zm2 2v8h14V8H5z"/>',
  mini: '<path fill="currentColor" d="M21 3H3a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h18a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zm0 16H3V5h18v14zm-3-8h-6v5h6v-5z"/>',
  full: '<path fill="currentColor" d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/>',
  exitFull: '<path fill="currentColor" d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z"/>',
  close: '<path fill="currentColor" d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>',
};

/**
 * Mount a player into `container`.
 *
 * @param {HTMLElement} container
 * @param {object} video      catalog video record
 * @param {object} opts       { startAt, autoplay, volume, muted, rate, onNext, nextLabel }
 * @returns player handle with .on(), .destroy(), .play(), etc.
 */
export function createPlayer(container, video, opts = {}) {
  const bus = emitter();
  const {
    startAt = 0, autoplay = false, volume = 1, muted = false, rate = 1,
    onNext = null, nextLabel = '',
  } = opts;

  const stage = el('div', { class: 'player-stage' });
  const surface = el('div', { class: 'player-surface' });
  const spinner = el('div', { class: 'player-spinner', 'aria-hidden': 'true' });
  const errorBox = el('div', { class: 'player-error', hidden: true });
  const bigPlay = el('button', { class: 'player-bigplay', 'aria-label': 'Play' }, icon(ICONS.play, { size: 40 }));
  const toast = el('div', { class: 'player-toast', 'aria-live': 'polite' });

  /* control bar */
  const btn = (name, label, path) =>
    el('button', { class: `pc-btn pc-${name}`, 'aria-label': label, title: label }, icon(path));

  const playBtn = btn('play', 'Play (k)', ICONS.play);
  const nextBtn = btn('next', nextLabel || 'Next', ICONS.next);
  const muteBtn = btn('mute', 'Mute (m)', ICONS.volHigh);
  const ccBtn = btn('cc', 'Subtitles (c)', ICONS.cc);
  const settingsBtn = btn('settings', 'Settings', ICONS.settings);
  const theaterBtn = btn('theater', 'Theater mode (t)', ICONS.theater);
  const miniBtn = btn('mini', 'Miniplayer (i)', ICONS.mini);
  const fullBtn = btn('full', 'Full screen (f)', ICONS.full);

  const volumeSlider = el('input', {
    class: 'pc-volume', type: 'range', min: '0', max: '1', step: '0.01',
    value: String(muted ? 0 : volume), 'aria-label': 'Volume',
  });

  const scrubBuffered = el('div', { class: 'pc-scrub-buffered' });
  const scrubPlayed = el('div', { class: 'pc-scrub-played' });
  const scrubKnob = el('div', { class: 'pc-scrub-knob' });
  const scrubHover = el('div', { class: 'pc-scrub-hover' });
  const scrubTip = el('div', { class: 'pc-scrub-tip', hidden: true });
  const scrub = el('div', {
    class: 'pc-scrub', role: 'slider', tabindex: '0',
    'aria-label': 'Seek', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0',
  }, el('div', { class: 'pc-scrub-track' }, scrubBuffered, scrubHover, scrubPlayed, scrubKnob), scrubTip);

  const timeLabel = el('span', { class: 'pc-time' }, '0:00 / 0:00');
  const menu = el('div', { class: 'pc-menu', hidden: true });

  const bar = el('div', { class: 'player-controls' },
    scrub,
    el('div', { class: 'pc-row' },
      playBtn,
      onNext ? nextBtn : null,
      el('div', { class: 'pc-volume-wrap' }, muteBtn, volumeSlider),
      timeLabel,
      el('div', { class: 'pc-spacer' }),
      ccBtn,
      el('div', { class: 'pc-menu-wrap' }, settingsBtn, menu),
      theaterBtn,
      miniBtn,
      fullBtn));

  stage.append(surface, spinner, bigPlay, toast, errorBox, bar);
  container.replaceChildren(stage);

  /* engine */
  const source = video.source || {};
  let engine;
  try {
    engine = source.type === 'youtube'
      ? new YouTubeEngine(bus, surface, { youtubeId: source.youtubeId, startAt, autoplay })
      : new FileEngine(bus, surface, {
          src: source.src, poster: source.poster || video.thumbnail,
          captions: source.captions || [], startAt, autoplay,
        });
  } catch (err) {
    bus.emit('error', err.message);
    engine = new Engine(bus);
  }

  /* state */
  let playing = false;
  let duration = video.durationSec || 0;
  let current = startAt;
  let scrubbing = false;
  let captionsOn = false;
  let currentRate = rate;
  let hideTimer;

  const isFullscreen = () => document.fullscreenElement === stage;

  function showToast(text) {
    toast.textContent = text;
    toast.classList.add('is-visible');
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => toast.classList.remove('is-visible'), 900);
  }

  function setIcon(button, path) {
    button.replaceChildren(icon(path));
  }

  function paint() {
    const ratio = duration ? clamp(current / duration, 0, 1) : 0;
    scrubPlayed.style.width = `${ratio * 100}%`;
    scrubKnob.style.left = `${ratio * 100}%`;
    scrubBuffered.style.width = `${clamp(engine.getBuffered(), 0, 1) * 100}%`;
    scrub.setAttribute('aria-valuenow', Math.round(ratio * 100));
    scrub.setAttribute('aria-valuetext', `${timecode(current)} of ${timecode(duration)}`);
    timeLabel.textContent = `${timecode(current)} / ${timecode(duration)}`;
  }

  function idleWatch() {
    stage.classList.remove('is-idle');
    clearTimeout(hideTimer);
    if (playing) hideTimer = setTimeout(() => stage.classList.add('is-idle'), 2600);
  }

  /* engine events */
  bus.on('ready', () => {
    spinner.classList.remove('is-on');
    engine.setVolume(volume);
    engine.setMuted(muted);
    if (currentRate !== 1) engine.setRate(currentRate);
    ccBtn.hidden = !engine.hasCaptions;
    engine.setCaptions(false);
    buildMenu();
    paint();
  });

  bus.on('durationchange', (d) => {
    if (d > 0) { duration = d; paint(); }
  });

  bus.on('timeupdate', (t, d) => {
    if (d > 0 && d !== duration) duration = d;
    if (!scrubbing) { current = t; paint(); }
    bus.emit('progress', t, duration);
  });

  bus.on('play', () => {
    playing = true;
    stage.classList.add('is-playing');
    stage.classList.remove('is-ended');
    spinner.classList.remove('is-on');
    setIcon(playBtn, ICONS.pause);
    playBtn.setAttribute('aria-label', 'Pause (k)');
    bigPlay.hidden = true;
    idleWatch();
  });

  bus.on('pause', () => {
    playing = false;
    stage.classList.remove('is-playing');
    setIcon(playBtn, ICONS.play);
    playBtn.setAttribute('aria-label', 'Play (k)');
    stage.classList.remove('is-idle');
    clearTimeout(hideTimer);
  });

  bus.on('waiting', () => spinner.classList.add('is-on'));

  bus.on('ended', () => {
    playing = false;
    stage.classList.add('is-ended');
    setIcon(playBtn, ICONS.replay);
    bigPlay.hidden = false;
    setIcon(bigPlay, ICONS.replay);
    stage.classList.remove('is-idle');
  });

  bus.on('blocked', () => {
    // Autoplay with sound is blocked until the user interacts.
    bigPlay.hidden = false;
    showToast('Press play to start');
  });

  bus.on('error', (message) => {
    spinner.classList.remove('is-on');
    bigPlay.hidden = true;
    errorBox.hidden = false;
    errorBox.replaceChildren(
      el('div', { class: 'player-error-inner' },
        el('strong', {}, 'This video can’t be played'),
        el('p', {}, message),
        source.type === 'youtube' && source.youtubeId
          ? el('a', {
              class: 'btn btn-ghost',
              href: `https://www.youtube.com/watch?v=${source.youtubeId}`,
              target: '_blank', rel: 'noopener noreferrer',
            }, 'Watch on YouTube')
          : null));
  });

  bus.on('ratechange', (r) => { currentRate = r; buildMenu(); });

  spinner.classList.add('is-on');

  /* controls wiring */
  const togglePlay = () => {
    if (stage.classList.contains('is-ended')) { engine.seek(0); engine.play(); return; }
    playing ? engine.pause() : engine.play();
  };

  playBtn.addEventListener('click', togglePlay);
  bigPlay.addEventListener('click', togglePlay);
  surface.addEventListener('click', (e) => { e.preventDefault(); togglePlay(); });
  surface.addEventListener('dblclick', () => toggleFullscreen());
  nextBtn.addEventListener('click', () => onNext?.());

  muteBtn.addEventListener('click', () => {
    const next = Number(volumeSlider.value) > 0 ? 0 : 1;
    volumeSlider.value = String(next);
    applyVolume(next, true);
  });
  volumeSlider.addEventListener('input', () => applyVolume(Number(volumeSlider.value), false));

  function applyVolume(v, announce) {
    engine.setVolume(v);
    engine.setMuted(v === 0);
    setIcon(muteBtn, v === 0 ? ICONS.volMute : v < 0.5 ? ICONS.volLow : ICONS.volHigh);
    muteBtn.setAttribute('aria-label', v === 0 ? 'Unmute (m)' : 'Mute (m)');
    if (announce) showToast(v === 0 ? 'Muted' : 'Unmuted');
    bus.emit('volumechange', v);
  }
  applyVolume(muted ? 0 : volume, false);

  ccBtn.addEventListener('click', () => {
    captionsOn = !captionsOn;
    engine.setCaptions(captionsOn);
    ccBtn.classList.toggle('is-active', captionsOn);
    showToast(captionsOn ? 'Subtitles on' : 'Subtitles off');
  });

  /* seeking */
  const ratioFromEvent = (e) => {
    const rect = scrub.getBoundingClientRect();
    const x = (e.touches?.[0]?.clientX ?? e.clientX) - rect.left;
    return clamp(x / rect.width, 0, 1);
  };

  const previewAt = (e) => {
    const r = ratioFromEvent(e);
    scrubHover.style.width = `${r * 100}%`;
    scrubTip.hidden = false;
    scrubTip.textContent = timecode(r * duration);
    scrubTip.style.left = `${r * 100}%`;
  };

  scrub.addEventListener('pointermove', previewAt);
  scrub.addEventListener('pointerleave', () => {
    if (!scrubbing) { scrubTip.hidden = true; scrubHover.style.width = '0%'; }
  });

  scrub.addEventListener('pointerdown', (e) => {
    scrubbing = true;
    scrub.setPointerCapture(e.pointerId);
    current = ratioFromEvent(e) * duration;
    paint();
    previewAt(e);
    const move = (ev) => {
      if (!scrubbing) return;
      current = ratioFromEvent(ev) * duration;
      paint();
      previewAt(ev);
    };
    const up = (ev) => {
      scrubbing = false;
      scrubTip.hidden = true;
      scrubHover.style.width = '0%';
      engine.seek(ratioFromEvent(ev) * duration);
      scrub.removeEventListener('pointermove', move);
      scrub.removeEventListener('pointerup', up);
      scrub.removeEventListener('pointercancel', up);
    };
    scrub.addEventListener('pointermove', move);
    scrub.addEventListener('pointerup', up);
    scrub.addEventListener('pointercancel', up);
  });

  scrub.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 30 : 5;
    if (e.key === 'ArrowRight') { e.preventDefault(); seekBy(step); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); seekBy(-step); }
    else if (e.key === 'Home') { e.preventDefault(); engine.seek(0); }
    else if (e.key === 'End') { e.preventDefault(); engine.seek(duration); }
  });

  function seekBy(delta) {
    const target = clamp(engine.getTime() + delta, 0, duration || Infinity);
    engine.seek(target);
    current = target;
    paint();
    showToast(`${delta > 0 ? '+' : ''}${Math.round(delta)}s`);
  }

  /* settings menu */
  function buildMenu() {
    const rates = engine.rates;
    menu.replaceChildren(
      el('div', { class: 'pc-menu-title' }, 'Playback speed'),
      ...rates.map((r) => el('button', {
        class: `pc-menu-item${Math.abs(r - currentRate) < 0.001 ? ' is-active' : ''}`,
        onclick: () => {
          currentRate = r;
          engine.setRate(r);
          menu.hidden = true;
          showToast(r === 1 ? 'Normal speed' : `${r}x`);
          buildMenu();
          bus.emit('ratechange', r);
        },
      }, r === 1 ? 'Normal' : `${r}x`)));
  }

  settingsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    menu.hidden = !menu.hidden;
    settingsBtn.classList.toggle('is-active', !menu.hidden);
  });
  document.addEventListener('click', () => {
    menu.hidden = true;
    settingsBtn.classList.remove('is-active');
  });
  menu.addEventListener('click', (e) => e.stopPropagation());

  /* layout modes */
  function toggleFullscreen() {
    if (isFullscreen()) document.exitFullscreen?.();
    else stage.requestFullscreen?.().catch(() => showToast('Full screen was blocked'));
  }
  fullBtn.addEventListener('click', toggleFullscreen);
  document.addEventListener('fullscreenchange', () => {
    const on = isFullscreen();
    stage.classList.toggle('is-fullscreen', on);
    setIcon(fullBtn, on ? ICONS.exitFull : ICONS.full);
  });

  theaterBtn.addEventListener('click', () => bus.emit('theater'));
  miniBtn.addEventListener('click', () => bus.emit('miniplayer'));

  stage.addEventListener('pointermove', throttle(idleWatch, 150));
  stage.addEventListener('pointerleave', () => { if (playing) stage.classList.add('is-idle'); });

  /* keyboard shortcuts — ignored while typing */
  function onKey(e) {
    const target = e.target;
    if (target.closest('input, textarea, select, [contenteditable="true"]')) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    const key = e.key.toLowerCase();
    const handlers = {
      ' ': togglePlay, k: togglePlay,
      j: () => seekBy(-10), l: () => seekBy(10),
      arrowleft: () => seekBy(-5), arrowright: () => seekBy(5),
      arrowup: () => nudgeVolume(0.05), arrowdown: () => nudgeVolume(-0.05),
      f: toggleFullscreen,
      t: () => bus.emit('theater'),
      i: () => bus.emit('miniplayer'),
      m: () => muteBtn.click(),
      c: () => { if (!ccBtn.hidden) ccBtn.click(); },
      n: () => onNext?.(),
      ',': () => stepRate(-1), '.': () => stepRate(1),
      home: () => engine.seek(0),
      end: () => engine.seek(duration),
    };

    if (/^[0-9]$/.test(key) && duration) {
      e.preventDefault();
      engine.seek((Number(key) / 10) * duration);
      showToast(`${Number(key) * 10}%`);
      return;
    }
    const fn = handlers[key];
    if (fn) { e.preventDefault(); fn(); idleWatch(); }
  }

  function nudgeVolume(delta) {
    const v = clamp(Number(volumeSlider.value) + delta, 0, 1);
    volumeSlider.value = String(v);
    applyVolume(v, false);
    showToast(`Volume ${Math.round(v * 100)}%`);
  }

  function stepRate(dir) {
    const rates = engine.rates;
    const i = rates.findIndex((r) => Math.abs(r - currentRate) < 0.001);
    const next = rates[clamp((i < 0 ? rates.indexOf(1) : i) + dir, 0, rates.length - 1)];
    currentRate = next;
    engine.setRate(next);
    showToast(next === 1 ? 'Normal speed' : `${next}x`);
    buildMenu();
  }

  document.addEventListener('keydown', onKey);

  return {
    el: stage,
    bus,
    on: bus.on,
    play: () => engine.play(),
    pause: () => engine.pause(),
    seek: (t) => engine.seek(t),
    getTime: () => engine.getTime(),
    getDuration: () => duration,
    isPlaying: () => playing,
    setRate: (r) => { currentRate = r; engine.setRate(r); buildMenu(); },
    getRate: () => currentRate,
    getVolume: () => Number(volumeSlider.value),
    setNext: (label) => {
      nextBtn.setAttribute('aria-label', label);
      nextBtn.title = label;
    },
    destroy() {
      document.removeEventListener('keydown', onKey);
      clearTimeout(hideTimer);
      clearTimeout(showToast.timer);
      engine.destroy();
      bus.clear();
      stage.remove();
    },
  };
}

export { ICONS, icon };
