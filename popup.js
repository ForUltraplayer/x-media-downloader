const DEFAULT_SETTINGS = {
  folderPath: 'X_Images',
  subfolderByUser: false,
  convertGif: true,
  filenamePattern: 'user_id_index',
  downloadCount: 0
};

const folderPathInput = document.getElementById('folderPath');
const subfolderByUserInput = document.getElementById('subfolderByUser');
const convertGifInput = document.getElementById('convertGif');
const filenamePatternSelect = document.getElementById('filenamePattern');
const pathPreviewEl = document.getElementById('pathPreview');
const statusMsgEl = document.getElementById('statusMsg');
const downloadCountEl = document.getElementById('downloadCount');
const settingsForm = document.getElementById('settings-form');
const openFolderBtn = document.getElementById('openFolderBtn');

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

function updatePreview() {
  const folder = sanitizeFolderPath(folderPathInput.value);
  const byUser = subfolderByUserInput.checked;
  const pattern = filenamePatternSelect.value;

  let sampleFile = 'user_1850000000000000000_01.jpg';
  if (pattern === 'id_index') {
    sampleFile = '1850000000000000000_01.jpg';
  } else if (pattern === 'media_id') {
    sampleFile = 'GbXyz123Abc.jpg';
  }

  const parts = ['다운로드'];
  if (folder) parts.push(folder);
  if (byUser) parts.push('user');
  parts.push(sampleFile);

  const fullPath = parts.join('/');
  pathPreviewEl.textContent = fullPath;
  pathPreviewEl.title = fullPath;
}

async function loadSettings() {
  const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  const settings = { ...DEFAULT_SETTINGS, ...stored };

  folderPathInput.value = settings.folderPath;
  subfolderByUserInput.checked = Boolean(settings.subfolderByUser);
  convertGifInput.checked = settings.convertGif !== false;
  filenamePatternSelect.value = settings.filenamePattern;
  downloadCountEl.textContent = String(settings.downloadCount || 0);

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

settingsForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const cleanFolder = sanitizeFolderPath(folderPathInput.value);
  folderPathInput.value = cleanFolder;

  await chrome.storage.sync.set({
    folderPath: cleanFolder,
    subfolderByUser: subfolderByUserInput.checked,
    convertGif: convertGifInput.checked,
    filenamePattern: filenamePatternSelect.value
  });

  updatePreview();
  showStatus('설정이 저장되었습니다.');
});

folderPathInput.addEventListener('input', updatePreview);
subfolderByUserInput.addEventListener('change', updatePreview);
filenamePatternSelect.addEventListener('change', updatePreview);

openFolderBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'OPEN_DOWNLOAD_FOLDER' });
});

loadSettings();
