importScripts('settings_common.js');

const { DEFAULT_SETTINGS, sanitizeSegment, sanitizeFolderPath, normalizePresets, pickActivePresetId } =
  XMediaSettings;

const OFFSCREEN_PATH = 'offscreen.html';
const MAX_ITEMS_PER_REQUEST = 100;
const IMAGE_EXTS = new Set(['jpg', 'png', 'webp', 'gif']);
const MEDIA_ID_PATTERN = /^[\w-]{1,64}$/;
const TWEET_ID_PATTERN = /^\d{1,25}$/;

let offscreenQueue = Promise.resolve();
let activeConversions = 0;
let downloadCountQueue = Promise.resolve();

// Items come from content.js, whose cache any script on x.com can fill through the
// page_hook CustomEvent. This is the single place they are checked before download/fetch.
function toSafeItem(item) {
  if (!item || typeof item.url !== 'string') return null;
  let url;
  try {
    url = new URL(item.url);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  const mediaId =
    typeof item.mediaId === 'string' && MEDIA_ID_PATTERN.test(item.mediaId) ? item.mediaId : undefined;

  if (item.type === 'image') {
    if (url.hostname !== 'pbs.twimg.com' || !url.pathname.startsWith('/media/')) return null;
    const format = (url.searchParams.get('format') || '').toLowerCase().replace(/^jpeg$/, 'jpg');
    if (!IMAGE_EXTS.has(format)) return null;
    return { type: 'image', url: url.href, mediaId, ext: format };
  }
  if (item.type === 'gif' || item.type === 'video') {
    if (url.hostname !== 'video.twimg.com' || !url.pathname.endsWith('.mp4')) return null;
    return { type: item.type, url: url.href, mediaId };
  }
  return null;
}

function resolveActiveFolderPath(settings, overrideFolderPath) {
  if (typeof overrideFolderPath === 'string') {
    return sanitizeFolderPath(overrideFolderPath);
  }
  const active = settings.presets.find((p) => p.id === settings.activePresetId) || settings.presets[0];
  return sanitizeFolderPath(active ? active.folderPath : settings.folderPath);
}

function buildFilename({ settings, folderPath, username, tweetId, mediaId, ext, index, total }) {
  const safeUser = sanitizeSegment(username) || 'unknown';
  const safeTweetId = sanitizeSegment(tweetId) || 'tweet';
  const safeMediaId = sanitizeSegment(mediaId) || `media_${index + 1}`;
  const safeExt = sanitizeSegment(ext) || 'jpg';
  const padWidth = total >= 10 ? 2 : 1;
  const paddedIndex = String(index + 1).padStart(padWidth, '0');

  let baseName;
  switch (settings.filenamePattern) {
    case 'id_index':
      baseName = `${safeTweetId}_${paddedIndex}`;
      break;
    case 'media_id':
      baseName = safeMediaId;
      break;
    case 'user_id_index':
    default:
      baseName = `${safeUser}_${safeTweetId}_${paddedIndex}`;
      break;
  }

  const parts = [];
  if (settings.useBaseFolder) {
    const rootFolder = sanitizeFolderPath(settings.baseFolderPath);
    if (rootFolder) {
      parts.push(rootFolder);
    }
  }
  const presetFolder = sanitizeFolderPath(folderPath);
  if (presetFolder) {
    parts.push(presetFolder);
  }
  if (settings.subfolderByUser) {
    parts.push(safeUser);
  }
  parts.push(`${baseName}.${safeExt}`);

  return parts.join('/');
}

async function getSettings() {
  const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  const presets = normalizePresets(stored);

  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    presets,
    activePresetId: pickActivePresetId(presets, stored.activePresetId)
  };
}

// Create and close calls share one chain, so a close can never interleave with a create.
function runOffscreenTask(task) {
  const run = offscreenQueue.then(task);
  offscreenQueue = run.catch(() => {});
  return run;
}

async function hasOffscreenDocument() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)]
  });
  return contexts.length > 0;
}

async function convertGifViaOffscreen(mp4Url) {
  activeConversions += 1;
  try {
    await runOffscreenTask(async () => {
      if (await hasOffscreenDocument()) return;
      await chrome.offscreen.createDocument({
        url: OFFSCREEN_PATH,
        reasons: ['BLOBS'],
        justification: 'Convert X.com MP4 GIFs to .gif files using video, canvas and Blob objects'
      });
    });
    const res = await chrome.runtime.sendMessage({ type: 'CONVERT_MP4_TO_GIF', mp4Url });
    if (!res?.ok || !res.dataUrl) {
      throw new Error(res?.error || 'GIF 변환 실패');
    }
    return res.dataUrl;
  } finally {
    activeConversions -= 1;
    // Offscreen documents without AUDIO_PLAYBACK never close on their own, so release it when idle.
    // The count is re-checked inside the chain because another conversion may start meanwhile.
    runOffscreenTask(async () => {
      if (activeConversions === 0 && (await hasOffscreenDocument())) {
        await chrome.offscreen.closeDocument();
      }
    }).catch((err) => console.warn('[X-MEDIA-DL] Offscreen close failed:', err));
  }
}

// Serialized so concurrent download requests do not overwrite each other's increments.
function addDownloadCount(amount) {
  downloadCountQueue = downloadCountQueue
    .then(async () => {
      const { downloadCount } = await chrome.storage.sync.get({ downloadCount: 0 });
      await chrome.storage.sync.set({ downloadCount: (Number(downloadCount) || 0) + amount });
    })
    .catch((err) => console.warn('[X-MEDIA-DL] downloadCount update failed:', err));
  return downloadCountQueue;
}

async function fetchSyndicationMedia(tweetId) {
  const token = ((Number(tweetId) / 1e15) * Math.PI)
    .toString(36)
    .replace(/(0+|\.)/g, '');
  const url = `https://cdn.syndication.twimg.com/tweet-result?id=${encodeURIComponent(tweetId)}&token=${encodeURIComponent(token || 'a')}`;
  const res = await fetch(url);
  if (!res.ok) return [];
  const data = await res.json();
  const details = Array.isArray(data?.mediaDetails) ? data.mediaDetails : [];
  const items = [];

  for (let i = 0; i < details.length; i++) {
    const m = details[i];
    if (!m) continue;
    if (m.type === 'photo' && typeof m.media_url_https === 'string') {
      try {
        const u = new URL(m.media_url_https);
        const rawSegment = u.pathname.split('/media/')[1]?.split('/')[0] || '';
        const cleanSegment = rawSegment.split(':')[0];
        const dotIdx = cleanSegment.lastIndexOf('.');
        const mediaId = dotIdx > 0 ? cleanSegment.slice(0, dotIdx) : cleanSegment || m.id_str || `${tweetId}_img_${i}`;
        let format = dotIdx > 0 ? cleanSegment.slice(dotIdx + 1).toLowerCase() : 'jpg';
        if (format === 'jpeg') format = 'jpg';
        items.push({
          type: 'image',
          url: `https://pbs.twimg.com/media/${mediaId}?format=${encodeURIComponent(format)}&name=orig`,
          mediaId,
          ext: format
        });
      } catch {
        // Ignore malformed URL
      }
    } else if (m.type === 'animated_gif' || m.type === 'video') {
      const variants = Array.isArray(m.video_info?.variants) ? m.video_info.variants : [];
      const best = variants
        .filter((v) => v && v.content_type === 'video/mp4' && typeof v.url === 'string')
        .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
      if (best?.url) {
        items.push({
          type: m.type === 'animated_gif' ? 'gif' : 'video',
          url: best.url,
          mediaId: m.id_str || `${tweetId}_vid_${i}`
        });
      }
    }
  }
  return items;
}

async function downloadItems(items, settings, folderPath, username, tweetId) {
  let started = 0;
  let failed = 0;
  let lastError = '';
  let cursor = 0;
  const concurrency = 3;

  async function processOne(item, index) {
    let downloadUrl = item.url;
    let ext = item.type === 'image' ? item.ext : 'mp4';

    if (item.type === 'gif' && settings.convertGif) {
      downloadUrl = await convertGifViaOffscreen(item.url);
      ext = 'gif';
    }

    const filename = buildFilename({
      settings,
      folderPath,
      username,
      tweetId,
      mediaId: item.mediaId,
      ext,
      index,
      total: items.length
    });

    const downloadId = await chrome.downloads.download({
      url: downloadUrl,
      filename,
      conflictAction: 'uniquify',
      saveAs: false
    });

    if (typeof downloadId === 'number') {
      started += 1;
    } else {
      failed += 1;
    }
  }

  async function worker() {
    while (cursor < items.length) {
      const idx = cursor++;
      try {
        await processOne(items[idx], idx);
      } catch (err) {
        console.error('[X-MEDIA-DL] Download failed:', items[idx]?.url, err);
        failed += 1;
        lastError = err?.message || lastError;
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return { started, failed, lastError };
}

chrome.runtime.onInstalled.addListener(async () => {
  const current = await chrome.storage.sync.get(null);
  if (Object.keys(current).length === 0) {
    await chrome.storage.sync.set(DEFAULT_SETTINGS);
    return;
  }

  const updates = {};
  if (!Array.isArray(current.presets) || current.presets.length === 0) {
    const presets = normalizePresets(current);
    updates.presets = presets;
    updates.activePresetId = presets[0].id;
  }
  if (typeof current.convertGif !== 'boolean') {
    updates.convertGif = true;
  }
  if (!current.clickMode) {
    updates.clickMode = DEFAULT_SETTINGS.clickMode;
  }
  if (typeof current.rememberPreset !== 'boolean') {
    updates.rememberPreset = DEFAULT_SETTINGS.rememberPreset;
  }
  if (typeof current.useBaseFolder !== 'boolean') {
    updates.useBaseFolder = DEFAULT_SETTINGS.useBaseFolder;
  }
  if (typeof current.baseFolderPath !== 'string') {
    updates.baseFolderPath = DEFAULT_SETTINGS.baseFolderPath;
  }
  if (Object.keys(updates).length > 0) {
    await chrome.storage.sync.set(updates);
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'DOWNLOAD_MEDIA') {
    (async () => {
      try {
        const rawItems = Array.isArray(message.items) ? message.items : [];
        const items = rawItems.slice(0, MAX_ITEMS_PER_REQUEST).map(toSafeItem).filter(Boolean);
        const rejected = rawItems.length - items.length;
        if (rejected > 0) {
          console.warn(`[X-MEDIA-DL] Dropped ${rejected} media item(s) that failed validation`);
        }

        if (items.length === 0) {
          sendResponse({ ok: false, error: '다운로드할 수 있는 미디어가 없습니다.' });
          return;
        }

        const settings = await getSettings();
        const targetFolderPath = resolveActiveFolderPath(settings, message.folderPath);
        const username = typeof message.username === 'string' ? message.username.replace(/\W/g, '_') : '';
        const tweetId = TWEET_ID_PATTERN.test(message.tweetId) ? message.tweetId : '';
        const { started, failed, lastError } = await downloadItems(
          items,
          settings,
          targetFolderPath,
          username,
          tweetId
        );

        if (started > 0) {
          await addDownloadCount(started);
        }

        sendResponse({
          ok: started > 0,
          total: rawItems.length,
          started,
          failed: failed + rejected,
          error: started > 0 ? undefined : lastError || undefined
        });
      } catch (err) {
        console.error('[X-MEDIA-DL] Error handling DOWNLOAD_MEDIA:', err);
        sendResponse({ ok: false, error: err?.message || '알 수 없는 오류' });
      }
    })();
    return true;
  }

  if (message?.type === 'FETCH_SYNDICATION_MEDIA') {
    (async () => {
      try {
        if (!TWEET_ID_PATTERN.test(message.tweetId)) {
          sendResponse({ ok: false, items: [], error: '잘못된 트윗 ID' });
          return;
        }
        const items = await fetchSyndicationMedia(message.tweetId);
        sendResponse({ ok: true, items });
      } catch (err) {
        sendResponse({ ok: false, items: [], error: err?.message });
      }
    })();
    return true;
  }

  if (message?.type === 'OPEN_DOWNLOAD_FOLDER') {
    chrome.downloads.showDefaultFolder();
    sendResponse({ ok: true });
    return false;
  }

  return false;
});
