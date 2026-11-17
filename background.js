const DEFAULT_SETTINGS = {
  folderPath: 'X_Images',
  subfolderByUser: false,
  filenamePattern: 'user_id_index',
  convertGif: true,
  downloadCount: 0
};

let creatingOffscreen = null;

function sanitizeSegment(segment) {
  return String(segment || '')
    .replace(/[<>:"|?*\x00-\x1F]/g, '_')
    .replace(/^\.+|\.+$/g, '')
    .trim();
}

function sanitizeFolderPath(rawPath) {
  if (!rawPath) return '';
  return String(rawPath)
    .replace(/\\/g, '/')
    .split('/')
    .map(sanitizeSegment)
    .filter((seg) => seg && seg !== '.' && seg !== '..')
    .join('/');
}

function buildFilename({ settings, username, tweetId, mediaId, ext, index, total }) {
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
  const baseFolder = sanitizeFolderPath(settings.folderPath);
  if (baseFolder) {
    parts.push(baseFolder);
  }
  if (settings.subfolderByUser) {
    parts.push(safeUser);
  }
  parts.push(`${baseName}.${safeExt}`);

  return parts.join('/');
}

async function getSettings() {
  const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  return { ...DEFAULT_SETTINGS, ...stored };
}

async function ensureOffscreenDocument() {
  const offscreenUrl = chrome.runtime.getURL('offscreen.html');
  if (chrome.runtime.getContexts) {
    const existing = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [offscreenUrl]
    });
    if (existing.length > 0) return;
  }

  if (creatingOffscreen) {
    await creatingOffscreen;
    return;
  }

  creatingOffscreen = chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['DOM_PARSER'],
    justification: 'Convert X.com MP4 GIFs to real .gif files using video and canvas elements'
  });

  try {
    await creatingOffscreen;
  } finally {
    creatingOffscreen = null;
  }
}

async function convertGifViaOffscreen(mp4Url) {
  await ensureOffscreenDocument();
  const res = await chrome.runtime.sendMessage({
    type: 'CONVERT_MP4_TO_GIF',
    mp4Url
  });
  if (!res || !res.ok || !res.dataUrl) {
    throw new Error(res?.error || 'GIF 변환 실패');
  }
  return res.dataUrl;
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
    if (m.type === 'animated_gif' || m.type === 'video') {
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

async function downloadItems(items, settings, username, tweetId) {
  let started = 0;
  let failed = 0;
  let cursor = 0;
  const concurrency = 3;

  async function processOne(item, index) {
    let downloadUrl = item.url;
    let ext = item.ext || (item.type === 'video' ? 'mp4' : 'jpg');

    if (item.type === 'gif') {
      if (settings.convertGif) {
        downloadUrl = await convertGifViaOffscreen(item.url);
        ext = 'gif';
      } else {
        ext = 'mp4';
      }
    }

    const filename = buildFilename({
      settings,
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
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return { started, failed };
}

chrome.runtime.onInstalled.addListener(async () => {
  const current = await chrome.storage.sync.get(null);
  if (Object.keys(current).length === 0) {
    await chrome.storage.sync.set(DEFAULT_SETTINGS);
  } else if (typeof current.convertGif !== 'boolean') {
    await chrome.storage.sync.set({ convertGif: true });
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'DOWNLOAD_MEDIA' || message?.type === 'DOWNLOAD_IMAGES') {
    (async () => {
      try {
        const rawItems = Array.isArray(message.items)
          ? message.items
          : Array.isArray(message.images)
            ? message.images.map((img) => ({ ...img, type: 'image' }))
            : [];

        if (rawItems.length === 0) {
          sendResponse({ ok: false, error: '다운로드할 미디어가 없습니다.' });
          return;
        }

        const settings = await getSettings();
        const { started, failed } = await downloadItems(
          rawItems,
          settings,
          message.username,
          message.tweetId
        );

        if (started > 0) {
          const nextCount = (Number(settings.downloadCount) || 0) + started;
          await chrome.storage.sync.set({ downloadCount: nextCount });
        }

        sendResponse({
          ok: started > 0,
          total: rawItems.length,
          started,
          failed
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
