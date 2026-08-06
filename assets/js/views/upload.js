// The upload page.
//
// Drop a file (or pick one), watch it upload, fill in the details, publish. The
// file goes straight from the browser to the bucket — it never passes through
// the server, which is what makes uploading a two-gigabyte video viable on a
// serverless host.
//
// With no bucket configured the same page still reads the file locally for its
// duration and thumbnail, then asks where it's hosted. Nothing here pretends.

import { el, timecode, slugify, uid, setChildren } from '../util.js';
import { TOPICS } from '../config.js';
import { api } from '../api.js';
import { auth, isSignedIn, promptSignIn } from '../auth.js';
import { loadCatalog } from '../store.js';
import { probeVideoFile, captureThumbnail, uploadFile, formatBytes } from '../upload.js';
import { button, toast, emptyState, svgIcon } from '../components.js';
import { navigate } from '../router.js';
import { setView, onViewTeardown } from '../app.js';

export default function uploadView() {
  if (!isSignedIn()) {
    setView(emptyState('plus', 'Sign in to post a video',
      auth.features.auth
        ? 'Your videos appear on your own channel. It takes a moment to set up.'
        : 'Accounts aren’t configured on this deployment yet — see the README for the environment variables it needs.',
      auth.features.auth
        ? button('Sign in', {
            variant: 'primary',
            onClick: () => promptSignIn({ reason: 'Sign in to post a video.' })
              .then((user) => { if (user) uploadView(); }),
          })
        : null),
      { title: 'Upload' });
    return;
  }

  setView(buildUploader(), { title: 'Upload' });
}

function buildUploader() {
  /* ---- state ---- */
  let file = null;              // the chosen File, when uploading
  let videoUrl = null;          // final hosted URL (uploaded or pasted)
  let thumbnailUrl = null;
  let thumbnailBlob = null;
  let durationSec = 0;
  let controller = null;        // aborts an upload in flight
  let uploading = false;
  let published = false;

  const page = el('div', { class: 'upload-page' });

  /* ---- drop zone ---- */
  const fileInput = el('input', {
    type: 'file',
    accept: 'video/mp4,video/webm,video/ogg,video/quicktime,video/x-matroska,video/*',
    class: 'sr-only',
    onchange: (e) => { if (e.target.files?.[0]) accept(e.target.files[0]); },
  });

  const dropZone = el('div', {
    class: 'dropzone',
    tabindex: '0',
    role: 'button',
    'aria-label': 'Choose a video file to upload',
    onclick: () => fileInput.click(),
    onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } },
  },
    el('div', { class: 'dropzone-icon' }, svgIcon('upload', 48)),
    el('div', { class: 'dropzone-title' }, 'Drag a video here'),
    el('div', { class: 'dropzone-sub' }, 'or click to choose a file'),
    el('div', { class: 'dropzone-hint' }, 'MP4, WebM, MOV or MKV'),
    fileInput);

  // Counter-based tracking: dragleave fires when crossing child elements too,
  // so a simple boolean flickers.
  let dragDepth = 0;
  const onDragEnter = (e) => {
    if (!e.dataTransfer?.types?.includes('Files')) return;
    e.preventDefault();
    dragDepth += 1;
    dropZone.classList.add('is-dragging');
  };
  const onDragOver = (e) => { if (e.dataTransfer?.types?.includes('Files')) e.preventDefault(); };
  const onDragLeave = () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) dropZone.classList.remove('is-dragging');
  };
  const onDrop = (e) => {
    if (!e.dataTransfer?.files?.length) return;
    e.preventDefault();
    dragDepth = 0;
    dropZone.classList.remove('is-dragging');
    accept(e.dataTransfer.files[0]);
  };

  for (const [type, fn] of [['dragenter', onDragEnter], ['dragover', onDragOver],
    ['dragleave', onDragLeave], ['drop', onDrop]]) {
    window.addEventListener(type, fn);
  }
  onViewTeardown(() => {
    for (const [type, fn] of [['dragenter', onDragEnter], ['dragover', onDragOver],
      ['dragleave', onDragLeave], ['drop', onDrop]]) {
      window.removeEventListener(type, fn);
    }
    controller?.abort();
  });

  /* ---- progress ---- */
  const progressBar = el('div', { class: 'upload-progress-bar' });
  const progressLabel = el('div', { class: 'upload-progress-label' });
  const cancelBtn = el('button', { class: 'linklike', onclick: () => controller?.abort() }, 'Cancel');
  const progressPanel = el('div', { class: 'upload-progress', hidden: true },
    el('div', { class: 'upload-progress-track' }, progressBar),
    el('div', { class: 'upload-progress-row' }, progressLabel, cancelBtn));

  const filePanel = el('div', { class: 'upload-file', hidden: true });

  /* ---- link fallback ---- */
  const linkInput = el('input', {
    class: 'input', type: 'url', placeholder: 'https://example.com/my-film.mp4',
    oninput: () => {
      videoUrl = linkInput.value.trim() || null;
      updatePublishState();
    },
  });

  const linkPanel = el('div', { class: 'panel' },
    el('h2', { class: 'panel-title' }, auth.features.uploads ? 'Or link a file you host' : 'Where is the file?'),
    el('p', { class: 'panel-sub' },
      auth.features.uploads
        ? 'Already hosting it somewhere? Paste the direct URL instead of uploading.'
        : 'This deployment has no storage bucket connected, so paste a direct link to the video file. '
          + 'It needs to allow playback from other sites (CORS).'),
    el('div', { class: 'form-row' },
      el('label', { class: 'form-label' }, 'Direct video URL'),
      linkInput,
      el('div', { class: 'form-hint' }, 'Must end in a playable file — .mp4, .webm or an HLS .m3u8 stream.')));

  /* ---- details form ---- */
  const title = el('input', { class: 'input', maxlength: '200', placeholder: 'Give it a title', oninput: updatePublishState });
  const description = el('textarea', { class: 'textarea', maxlength: '5000', placeholder: 'What is it about?' });
  const durationInput = el('input', {
    class: 'input', placeholder: '52:00', oninput: () => { durationSec = parseDuration(durationInput.value); updatePublishState(); },
  });
  const published_ = el('input', { class: 'input', type: 'date', value: new Date().toISOString().slice(0, 10) });

  const chosenTopics = new Set();
  const topicBar = el('div', { class: 'chipbar', style: { position: 'static', flexWrap: 'wrap', paddingBottom: 0 } },
    ...TOPICS.map((topic) => {
      const chip = el('button', {
        type: 'button', class: 'chip',
        onclick: () => {
          if (chosenTopics.has(topic)) chosenTopics.delete(topic); else chosenTopics.add(topic);
          chip.classList.toggle('is-active', chosenTopics.has(topic));
        },
      }, topic);
      return chip;
    }));

  const thumbPreview = el('div', { class: 'thumb-preview' },
    el('div', { class: 'thumb-placeholder' }, svgIcon('film', 28)));

  const thumbInput = el('input', {
    type: 'file', accept: 'image/jpeg,image/png,image/webp', class: 'sr-only',
    onchange: async (e) => {
      const picked = e.target.files?.[0];
      if (!picked) return;
      thumbnailBlob = picked;
      showThumb(URL.createObjectURL(picked));
      if (auth.features.uploads) {
        try {
          const { url } = await uploadFile(picked, { kind: 'thumbnail' });
          thumbnailUrl = url;
        } catch (err) {
          toast(`Thumbnail upload failed: ${err.message}`, { duration: 6000 });
        }
      }
    },
  });

  const thumbUrlInput = el('input', {
    class: 'input', type: 'url', placeholder: 'https://…/thumbnail.jpg',
    oninput: () => { thumbnailUrl = thumbUrlInput.value.trim() || null; },
  });

  const publishBtn = button('Publish', { variant: 'primary', disabled: true, onClick: publish });

  const detailsPanel = el('div', { class: 'panel', hidden: true },
    el('h2', { class: 'panel-title' }, 'Details'),
    el('div', { class: 'upload-details' },
      el('div', { class: 'form-grid' },
        el('div', { class: 'form-row' }, el('label', { class: 'form-label' }, 'Title'), title),
        el('div', { class: 'form-row' }, el('label', { class: 'form-label' }, 'Description'), description),
        el('div', { class: 'form-row-2' },
          el('div', { class: 'form-row' },
            el('label', { class: 'form-label' }, 'Length'),
            durationInput,
            el('div', { class: 'form-hint' }, 'Read from the file where possible.')),
          el('div', { class: 'form-row' }, el('label', { class: 'form-label' }, 'Date'), published_)),
        el('div', { class: 'form-row' }, el('label', { class: 'form-label' }, 'Topics'), topicBar)),
      el('div', { class: 'upload-thumb-col' },
        el('label', { class: 'form-label' }, 'Thumbnail'),
        thumbPreview,
        el('div', { class: 'upload-thumb-actions' },
          el('button', { class: 'btn btn-subtle size-sm', onclick: () => thumbInput.click() }, 'Choose image'),
          thumbInput),
        auth.features.uploads ? null : el('div', { class: 'form-row', style: { marginTop: '.6rem' } },
          el('label', { class: 'form-label' }, 'Or thumbnail URL'), thumbUrlInput))),
    el('div', { class: 'form-actions' },
      button('Discard', { variant: 'ghost', onClick: reset }),
      publishBtn));

  /* ---- assembly ---- */
  setChildren(page,
    el('div', { class: 'page-head' },
      el('h1', { class: 'page-title' }, 'Post a video'),
      el('p', { class: 'page-sub' },
        auth.features.uploads
          ? 'It uploads straight from your device to storage, and appears on your channel.'
          : 'Link a video you host, and it appears on your channel.')),
    auth.features.uploads ? dropZone : null,
    progressPanel,
    filePanel,
    linkPanel,
    detailsPanel);

  /* ---- behaviour ---- */

  function showThumb(src) {
    setChildren(thumbPreview, el('img', { src, alt: '' }));
  }

  function parseDuration(value) {
    const s = String(value || '').trim();
    if (!s) return 0;
    if (/^\d+$/.test(s)) return Number(s);
    const parts = s.split(':').map(Number);
    if (parts.some(Number.isNaN)) return 0;
    return parts.reduce((total, part) => total * 60 + part, 0);
  }

  function updatePublishState() {
    publishBtn.disabled = uploading || !videoUrl || !title.value.trim() || !durationSec;
  }

  function reset() {
    controller?.abort();
    file = null; videoUrl = null; thumbnailUrl = null; thumbnailBlob = null; durationSec = 0;
    uploading = false; published = false;
    progressPanel.hidden = true;
    filePanel.hidden = true;
    detailsPanel.hidden = true;
    linkPanel.hidden = false;
    dropZone.hidden = !auth.features.uploads;
    title.value = ''; description.value = ''; durationInput.value = ''; linkInput.value = '';
    setChildren(thumbPreview, el('div', { class: 'thumb-placeholder' }, svgIcon('film', 28)));
    chosenTopics.clear();
    for (const chip of topicBar.querySelectorAll('.chip')) chip.classList.remove('is-active');
    updatePublishState();
  }

  /** A file has been chosen — read it locally, then upload if we can. */
  async function accept(picked) {
    if (!picked.type.startsWith('video/')) {
      toast('That doesn’t look like a video file.');
      return;
    }
    file = picked;

    dropZone.hidden = true;
    filePanel.hidden = false;
    setChildren(filePanel,
      el('div', { class: 'upload-file-name' }, svgIcon('film', 20), el('span', {}, picked.name)),
      el('div', { class: 'upload-file-meta' }, formatBytes(picked.size)));

    detailsPanel.hidden = false;
    if (!title.value.trim()) {
      title.value = picked.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').slice(0, 200);
    }
    updatePublishState();

    // Read duration and grab a thumbnail before touching the network — this is
    // the part that works with or without a bucket.
    try {
      const probe = await probeVideoFile(picked);
      durationSec = probe.durationSec;
      durationInput.value = timecode(durationSec);
    } catch (err) {
      toast(err.message, { duration: 6000 });
    }
    updatePublishState();

    captureThumbnail(picked)
      .then(async (blob) => {
        thumbnailBlob = blob;
        showThumb(URL.createObjectURL(blob));
        if (auth.features.uploads) {
          try {
            const { url } = await uploadFile(blob, { kind: 'thumbnail' });
            thumbnailUrl = url;
          } catch { /* the video matters more; a missing thumbnail degrades fine */ }
        }
      })
      .catch(() => { /* no frame available — the placeholder stands */ });

    if (!auth.features.uploads) {
      linkPanel.hidden = false;
      toast('Read the file locally. Now paste where it’s hosted so others can watch it.', { duration: 7000 });
      return;
    }

    await startUpload(picked);
  }

  async function startUpload(picked) {
    uploading = true;
    updatePublishState();
    linkPanel.hidden = true;
    progressPanel.hidden = false;
    progressBar.style.width = '0%';
    progressLabel.textContent = 'Starting…';
    cancelBtn.hidden = false;

    controller = new AbortController();
    try {
      const { url } = await uploadFile(picked, {
        kind: 'video',
        signal: controller.signal,
        onProgress: (ratio, loaded, total) => {
          progressBar.style.width = `${Math.round(ratio * 100)}%`;
          progressLabel.textContent = ratio >= 1
            ? 'Processing…'
            : `${Math.round(ratio * 100)}% · ${formatBytes(loaded)} of ${formatBytes(total)}`;
        },
      });
      videoUrl = url;
      progressBar.style.width = '100%';
      progressBar.classList.add('is-done');
      progressLabel.textContent = 'Uploaded';
      cancelBtn.hidden = true;
    } catch (err) {
      progressPanel.hidden = true;
      if (err.cancelled) {
        toast('Upload cancelled');
        reset();
        return;
      }
      // Falling back to the link field is better than a dead end.
      linkPanel.hidden = false;
      toast(err.message, { duration: 9000 });
    } finally {
      uploading = false;
      controller = null;
      updatePublishState();
    }
  }

  async function publish() {
    if (published) return;
    const name = title.value.trim();
    if (!name || !videoUrl || !durationSec) return;

    publishBtn.disabled = true;
    const pending = toast('Publishing…', { duration: 60000 });

    const record = {
      id: `v_${slugify(name).slice(0, 48) || uid('vid')}_${Math.random().toString(36).slice(2, 7)}`,
      title: name,
      // The server overrides this with the poster's own channel; sending the
      // known id keeps the optimistic UI honest in the common case.
      channelId: auth.user.channelId,
      description: description.value.trim(),
      publishedAt: published_.value || new Date().toISOString().slice(0, 10),
      durationSec,
      topics: [...chosenTopics],
      tags: [],
      views: 0,
      likes: 0,
      source: { type: 'file', src: videoUrl, ...(thumbnailUrl ? { poster: thumbnailUrl } : {}) },
      ...(thumbnailUrl ? { thumbnail: thumbnailUrl } : {}),
    };

    try {
      const { item } = await api.saveItem('videos', record);
      await loadCatalog({ fresh: true });
      published = true;
      pending.remove();
      toast('Published');
      navigate('/watch', { v: item.id });
    } catch (err) {
      pending.remove();
      publishBtn.disabled = false;
      toast(`Could not publish: ${err.message}`, { duration: 9000 });
    }
  }

  updatePublishState();
  return page;
}
