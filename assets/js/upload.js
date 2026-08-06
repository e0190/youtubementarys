// Upload plumbing: reading a video file in the browser, and getting it into
// the bucket.
//
// Two things happen locally before anything is sent. The file's duration comes
// from a <video> element, and a thumbnail is grabbed by seeking a little way in
// and painting that frame to a canvas. Both mean the details form arrives
// already filled in — and both still work when no bucket is configured, which
// is why the "paste a link" path isn't a second-class experience.

import { api } from './api.js';

/** Read duration and dimensions without uploading anything. */
export function probeVideoFile(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.muted = true;

    const done = (result, err) => {
      clearTimeout(timer);
      URL.revokeObjectURL(url);
      video.removeAttribute('src');
      err ? reject(err) : resolve(result);
    };
    const timer = setTimeout(
      () => done(null, new Error('Could not read that video — the browser may not support its format.')),
      20000);

    video.addEventListener('loadedmetadata', () => {
      done({
        durationSec: Number.isFinite(video.duration) ? Math.round(video.duration) : 0,
        width: video.videoWidth,
        height: video.videoHeight,
      });
    });
    video.addEventListener('error', () => {
      done(null, new Error('That file isn’t a video this browser can play.'));
    });

    video.src = url;
  });
}

/**
 * Capture a frame as a JPEG blob.
 *
 * Seeks a little way in by default — the first frame of a video is very often
 * black, which makes for a poor thumbnail.
 */
export function captureThumbnail(file, { at = null, maxWidth = 1280, quality = 0.82 } = {}) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.muted = true;
    video.playsInline = true;

    const cleanup = () => {
      clearTimeout(timer);
      URL.revokeObjectURL(url);
      video.removeAttribute('src');
    };
    const fail = (message) => { cleanup(); reject(new Error(message)); };
    const timer = setTimeout(() => fail('Timed out while making a thumbnail.'), 25000);

    video.addEventListener('loadedmetadata', () => {
      const target = at ?? Math.min(video.duration * 0.1 || 0, 10);
      // Seeking to exactly 0 gives a black frame surprisingly often.
      video.currentTime = Math.max(0.1, target);
    });

    video.addEventListener('seeked', () => {
      try {
        const scale = Math.min(1, maxWidth / (video.videoWidth || maxWidth));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round((video.videoWidth || 1280) * scale);
        canvas.height = Math.round((video.videoHeight || 720) * scale);
        canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
        canvas.toBlob((blob) => {
          cleanup();
          blob ? resolve(blob) : reject(new Error('Could not encode the thumbnail.'));
        }, 'image/jpeg', quality);
      } catch (err) {
        // Tainted canvas, or a codec the browser can decode but not paint.
        fail(`Could not read a frame: ${err.message}`);
      }
    });

    video.addEventListener('error', () => fail('That file isn’t a video this browser can play.'));
    video.src = url;
  });
}

/**
 * Upload a file straight to the bucket.
 *
 * XHR rather than fetch, because fetch still has no way to report upload
 * progress — and a progress bar is the whole point of this screen.
 */
export function uploadFile(file, { kind = 'video', onProgress, signal } = {}) {
  return new Promise(async (resolve, reject) => {
    let signed;
    try {
      signed = await api.signUpload({
        kind,
        filename: file.name,
        contentType: file.type || 'application/octet-stream',
        size: file.size,
      });
    } catch (err) {
      reject(err);
      return;
    }

    const xhr = new XMLHttpRequest();
    xhr.open('PUT', signed.uploadUrl, true);
    xhr.setRequestHeader('Content-Type', signed.contentType);

    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) onProgress?.(e.loaded / e.total, e.loaded, e.total);
    });

    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress?.(1, file.size, file.size);
        resolve({ url: signed.publicUrl, key: signed.key });
      } else {
        // Buckets answer with an XML <Message> on failure; surface that rather
        // than a bare status code, because it usually names the real problem
        // (clock skew, wrong region, missing CORS rule).
        const detail = /<Message>([^<]+)<\/Message>/.exec(xhr.responseText || '')?.[1];
        reject(new Error(detail
          ? `Storage rejected the upload: ${detail}`
          : `Upload failed (${xhr.status}). Check the bucket's CORS rules allow PUT from this site.`));
      }
    });

    xhr.addEventListener('error', () => reject(new Error(
      'Upload failed. The bucket needs a CORS rule allowing PUT from this site.')));
    xhr.addEventListener('abort', () => reject(Object.assign(new Error('Upload cancelled.'), { cancelled: true })));

    signal?.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.send(file);
  });
}

export const formatBytes = (bytes) => {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** i;
  return `${value >= 100 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
};
