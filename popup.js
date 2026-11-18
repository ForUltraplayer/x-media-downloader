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
  convertGif: true,
  filenamePattern: 'user_id_index',
  downloadCount: 0
};

const useBaseFolderInput = document.getElementById('useBaseFolder');
const baseFolderPathInput = document.getElementById('baseFolderPath');
const presetListEl = document.getElementById('presetList');
const addPresetBtn = document.getElementById('addPresetBtn');
const clickModeSelect = document.getElementById('clickMode');
const rememberPresetInput = document.getElementById('rememberPreset');
const subfolderByUserInput = document.getElementById('subfolderByUser');
const convertGifInput = document.getElementById('convertGif');
const filenamePatternSelect = document.getElementById('filenamePattern');
const pathPreviewEl = document.getElementById('pathPreview');
const statusMsgEl = document.getElementById('statusMsg');
const downloadCountEl = document.getElementById('downloadCount');
const settingsForm = document.getElementById('settings-form');
const openFolderBtn = document.getElementById('openFolderBtn');

let presetsState = [];
let activePresetId = 'preset_default';

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

function getActivePreset() {
  return presetsState.find((p) => p.id === activePresetId) || presetsState[0];
}

function updateBaseFolderUi() {
  baseFolderPathInput.disabled = !useBaseFolderInput.checked;
}

function updatePreview() {
  const active = getActivePreset();
  const rootFolder = useBaseFolderInput.checked
    ? sanitizeFolderPath(baseFolderPathInput.value)
    : '';
  const folder = sanitizeFolderPath(active ? active.folderPath : '');
  const byUser = subfolderByUserInput.checked;
  const pattern = filenamePatternSelect.value;

  let sampleFile = 'user_1850000000000000000_01.jpg';
  if (pattern === 'id_index') {
    sampleFile = '1850000000000000000_01.jpg';
  } else if (pattern === 'media_id') {
    sampleFile = 'GbXyz123Abc.jpg';
  }

  const parts = ['다운로드'];
  if (rootFolder) parts.push(rootFolder);
  if (folder) parts.push(folder);
  if (byUser) parts.push('user');
  parts.push(sampleFile);

  const fullPath = parts.join('/');
  pathPreviewEl.textContent = fullPath;
  pathPreviewEl.title = fullPath;
}

function getCleanedPresets() {
  return presetsState.map((p) => {
    const cleanFolder = sanitizeFolderPath(p.folderPath);
    return {
      id: p.id,
      name: cleanFolder || '다운로드(기본)',
      folderPath: cleanFolder
    };
  });
}

let autoSaveTimer = null;
async function saveSettingsToStorage(normalizeInputs = false) {
  const cleaned = getCleanedPresets();
  if (normalizeInputs) {
    presetsState = cleaned;
  }
  if (!cleaned.some((p) => p.id === activePresetId)) {
    activePresetId = cleaned[0].id;
  }
  const active = cleaned.find((p) => p.id === activePresetId) || cleaned[0];

  const cleanBaseFolder = sanitizeFolderPath(baseFolderPathInput.value);
  if (normalizeInputs) {
    baseFolderPathInput.value = cleanBaseFolder;
  }

  await chrome.storage.sync.set({
    presets: cleaned,
    activePresetId,
    folderPath: active ? active.folderPath : '',
    useBaseFolder: useBaseFolderInput.checked,
    baseFolderPath: cleanBaseFolder,
    clickMode: clickModeSelect.value,
    rememberPreset: rememberPresetInput.checked,
    subfolderByUser: subfolderByUserInput.checked,
    convertGif: convertGifInput.checked,
    filenamePattern: filenamePatternSelect.value
  });
}

function scheduleAutoSave() {
  if (autoSaveTimer) clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(() => {
    saveSettingsToStorage(false);
  }, 200);
}

function renderPresets() {
  presetListEl.innerHTML = '';

  presetsState.forEach((preset) => {
    const row = document.createElement('div');
    row.className = 'preset-row';

    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'activePreset';
    radio.className = 'preset-radio';
    radio.checked = preset.id === activePresetId;
    radio.title = '기본 폴더로 선택';
    radio.addEventListener('change', () => {
      activePresetId = preset.id;
      updatePreview();
      saveSettingsToStorage(false);
    });

    const folderInput = document.createElement('input');
    folderInput.type = 'text';
    folderInput.className = 'preset-folder';
    folderInput.value = preset.folderPath;
    folderInput.placeholder = '폴더명 입력 (예: 일러스트, 짤방/저장)';
    folderInput.addEventListener('input', () => {
      preset.folderPath = folderInput.value;
      preset.name = sanitizeFolderPath(folderInput.value) || '다운로드(기본)';
      if (preset.id === activePresetId) {
        updatePreview();
      }
      scheduleAutoSave();
    });

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'preset-remove';
    removeBtn.textContent = '✕';
    removeBtn.title = '프리셋 삭제';
    removeBtn.disabled = presetsState.length <= 1;
    removeBtn.addEventListener('click', () => {
      if (presetsState.length <= 1) return;
      presetsState = presetsState.filter((p) => p.id !== preset.id);
      if (activePresetId === preset.id) {
        activePresetId = presetsState[0].id;
      }
      renderPresets();
      updatePreview();
      saveSettingsToStorage(false);
    });

    row.appendChild(radio);
    row.appendChild(folderInput);
    row.appendChild(removeBtn);
    presetListEl.appendChild(row);
  });
}

async function loadSettings() {
  const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  const settings = { ...DEFAULT_SETTINGS, ...stored };

  presetsState = normalizePresets(settings);
  activePresetId = presetsState.some((p) => p.id === settings.activePresetId)
    ? settings.activePresetId
    : presetsState[0].id;

  useBaseFolderInput.checked = Boolean(settings.useBaseFolder);
  baseFolderPathInput.value = settings.baseFolderPath ?? 'X_Images';
  clickModeSelect.value = settings.clickMode === 'always_menu' ? 'always_menu' : 'instant_hover';
  rememberPresetInput.checked = Boolean(settings.rememberPreset);
  subfolderByUserInput.checked = Boolean(settings.subfolderByUser);
  convertGifInput.checked = settings.convertGif !== false;
  filenamePatternSelect.value = settings.filenamePattern;
  downloadCountEl.textContent = String(settings.downloadCount || 0);

  updateBaseFolderUi();
  renderPresets();
  updatePreview();
}

let statusTimer = null;
function showStatus(text, isError = false) {
  statusMsgEl.textContent = text;
  statusMsgEl.style.color = isError ? '#f4212e' : '#00ba7c';
  if (statusTimer) clearTimeout(statusTimer);
  statusTimer = setTimeout(() => {
    statusMsgEl.textContent = '';
  }, 2200);
}

addPresetBtn.addEventListener('click', () => {
  const newId = `preset_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  presetsState.push({
    id: newId,
    name: '다운로드(기본)',
    folderPath: ''
  });
  renderPresets();
  saveSettingsToStorage(false);
  const folderInputs = presetListEl.querySelectorAll('.preset-folder');
  const lastInput = folderInputs[folderInputs.length - 1];
  if (lastInput) {
    lastInput.focus();
  }
});

settingsForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (autoSaveTimer) clearTimeout(autoSaveTimer);
  await saveSettingsToStorage(true);
  renderPresets();
  updatePreview();
  showStatus('설정이 저장되었습니다.');
});

useBaseFolderInput.addEventListener('change', () => {
  updateBaseFolderUi();
  updatePreview();
  saveSettingsToStorage(false);
  if (useBaseFolderInput.checked) {
    baseFolderPathInput.focus();
  }
});
baseFolderPathInput.addEventListener('input', () => {
  updatePreview();
  scheduleAutoSave();
});
clickModeSelect.addEventListener('change', () => saveSettingsToStorage(false));
rememberPresetInput.addEventListener('change', () => saveSettingsToStorage(false));
convertGifInput.addEventListener('change', () => saveSettingsToStorage(false));
subfolderByUserInput.addEventListener('change', () => {
  updatePreview();
  saveSettingsToStorage(false);
});
filenamePatternSelect.addEventListener('change', () => {
  updatePreview();
  saveSettingsToStorage(false);
});

openFolderBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'OPEN_DOWNLOAD_FOLDER' });
});

loadSettings();
