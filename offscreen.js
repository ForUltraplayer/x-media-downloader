(() => {
  'use strict';

  const HEARTBEAT_MS = 10000;
  const FETCH_TIMEOUT_MS = 30000;
  const MEDIA_EVENT_TIMEOUT_MS = 15000;

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || new Error('FileReader error'));
      reader.readAsDataURL(blob);
    });
  }

  // The timeout matters: the heartbeat keeps the service worker alive, so a stalled
  // video must fail here instead of hanging the conversion forever.
  function waitForEvent(target, eventName) {
    return new Promise((resolve, reject) => {
      const onOk = () => {
        cleanup();
        resolve();
      };
      const onErr = () => {
        cleanup();
        reject(new Error(`Video error during ${eventName}`));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Timed out waiting for ${eventName}`));
      }, MEDIA_EVENT_TIMEOUT_MS);
      const cleanup = () => {
        clearTimeout(timer);
        target.removeEventListener(eventName, onOk);
        target.removeEventListener('error', onErr);
      };
      target.addEventListener(eventName, onOk, { once: true });
      target.addEventListener('error', onErr, { once: true });
    });
  }

  async function convertMp4ToGifDataUrl(mp4Url) {
    const res = await fetch(mp4Url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) {
      throw new Error(`MP4 fetch failed: ${res.status}`);
    }
    const mp4Blob = await res.blob();
    const objectUrl = URL.createObjectURL(mp4Blob);
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';

    try {
      video.src = objectUrl;
      await waitForEvent(video, 'loadedmetadata');

      const srcW = video.videoWidth || 320;
      const srcH = video.videoHeight || 240;
      const maxDim = 480;
      let width = srcW;
      let height = srcH;
      if (Math.max(srcW, srcH) > maxDim) {
        const scale = maxDim / Math.max(srcW, srcH);
        width = Math.max(2, Math.round(srcW * scale));
        height = Math.max(2, Math.round(srcH * scale));
      }

      const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 1;
      const fps = 15;
      const maxFrames = 180;
      let frameCount = Math.max(1, Math.round(duration * fps));
      if (frameCount > maxFrames) {
        frameCount = maxFrames;
      }
      const stepSec = duration / frameCount;
      const delayCs = Math.max(2, Math.round(stepSec * 100));

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });

      const encoder = new window.GifEncoder(width, height);

      for (let i = 0; i < frameCount; i++) {
        const targetTime = Math.min(duration - 0.001, i * stepSec);
        video.currentTime = Math.max(0, targetTime);
        await waitForEvent(video, 'seeked');
        ctx.drawImage(video, 0, 0, width, height);
        const imageData = ctx.getImageData(0, 0, width, height);
        encoder.addFrame(imageData.data, delayCs);
      }

      const gifBytes = encoder.finish();
      const gifBlob = new Blob([gifBytes], { type: 'image/gif' });
      return await blobToDataUrl(gifBlob);
    } finally {
      video.removeAttribute('src');
      video.load();
      URL.revokeObjectURL(objectUrl);
    }
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== 'CONVERT_MP4_TO_GIF') {
      return false;
    }

    // The service worker only awaits our reply, and Chrome does not document that as
    // resetting its 30 s idle timer. Messages sent from an offscreen document do (Chrome 109+).
    const heartbeat = setInterval(() => {
      chrome.runtime.sendMessage({ type: 'GIF_CONVERT_HEARTBEAT' }).catch(() => {});
    }, HEARTBEAT_MS);

    (async () => {
      try {
        const dataUrl = await convertMp4ToGifDataUrl(message.mp4Url);
        sendResponse({ ok: true, dataUrl });
      } catch (err) {
        console.error('[X-MEDIA-DL] Offscreen GIF conversion failed:', err);
        sendResponse({ ok: false, error: err?.message || 'GIF 변환 실패' });
      } finally {
        clearInterval(heartbeat);
      }
    })();

    return true;
  });
})();
