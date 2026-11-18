const DEFAULT_PRESETS = [
  { id: 'preset_default', name: 'X_Images', folderPath: 'X_Images' }
];

const DEFAULT_SETTINGS = {
  folderPath: 'X_Images',
  presets: DEFAULT_PRESETS,
  activePresetId: 'preset_default',
  useBaseFolder: false,
  baseFolderPath: 'X_Images',
  clickMode: 'instant_hover',
  rememberPreset: false,
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

function normalizePresets(stored) {
  if (Array.isArray(stored.presets) && stored.presets.length > 0) {
    return stored.presets.map((p, idx) => {
      const folderPath = sanitizeFolderPath(p.folderPath);
      return {
        id: String(p.id || `preset_${idx + 1}`),
        name: folderPath || '다운로드(기본)',
        folderPath
      };
    });
  }
  const legacyFolder = sanitizeFolderPath(stored.folderPath ?? DEFAULT_SETTINGS.folderPath);
  return [
    {
      id: 'preset_default',
      name: legacyFolder || '다운로드(기본)',
      folderPath: legacyFolder
    }
  ];
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
  const activePresetId = presets.some((p) => p.id === stored.activePresetId)
    ? stored.activePresetId
    : presets[0].id;

  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    presets,
    activePresetId
  };
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
        const targetFolderPath = resolveActiveFolderPath(settings, message.folderPath);
        const { started, failed } = await downloadItems(
          rawItems,
          settings,
          targetFolderPath,
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
