/**
 * @file settings_common.js
 * @brief Settings defaults and download-path sanitizers shared by the service worker, popup and content script.
 */

const XMediaSettings = (() => {
  'use strict';

  const DEFAULT_SETTINGS = {
    folderPath: 'X_Images',
    presets: [{ id: 'preset_default', name: 'X_Images', folderPath: 'X_Images' }],
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

  // Slashes are replaced too: a segment must never introduce extra directories.
  // Leading/trailing dots and spaces are stripped together because Windows rejects either at the end.
  function sanitizeSegment(segment) {
    return String(segment || '')
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
      .replace(/^[.\s]+|[.\s]+$/g, '');
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

  function pickActivePresetId(presets, presetId) {
    return presets.some((p) => p.id === presetId) ? presetId : presets[0].id;
  }

  return { DEFAULT_SETTINGS, sanitizeSegment, sanitizeFolderPath, normalizePresets, pickActivePresetId };
})();
