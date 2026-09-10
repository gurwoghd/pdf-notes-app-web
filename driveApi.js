import * as auth from './auth.js?v=a72f8f4';
import { promptExportFileName } from './exportModal.js?v=a72f8f4';
import { GOOGLE_API_KEY, GOOGLE_APP_ID, APP_FOLDER_NAME } from './config.js?v=a72f8f4';

const FILES_URL = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files';

const DEFAULT_SETTINGS = {
  openPdfFiles: [],
  activePdfFileId: null,
  tools: {
    pen: { color: '#ff3b30', width: 3, favorites: ['#ff3b30', '#1a73e8', '#34a853'] },
    highlighter: { color: '#ffeb3b', width: 14, favorites: ['#ffeb3b', '#ff9800', '#ff6bcb'] },
    eraser: { width: 3 },
    text: { size: 28 },
  },
};

const SETTINGS_FILE_NAME = 'settings.json';

let appFolderIdCache = null;

async function driveFetch(url, options = {}) {
  const token = await auth.ensureAccessToken();
  const headers = { ...(options.headers || {}), Authorization: `Bearer ${token}` };
  const res = await fetch(url, { ...options, headers });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Drive API 오류 (${res.status}): ${text}`);
  }
  return res;
}

function escapeForQuery(value) {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

async function getOrCreateAppFolder() {
  if (appFolderIdCache) return appFolderIdCache;

  const q = encodeURIComponent(
    `name='${escapeForQuery(APP_FOLDER_NAME)}' and mimeType='application/vnd.google-apps.folder' and trashed=false`
  );
  const listRes = await driveFetch(`${FILES_URL}?q=${q}&fields=files(id,name)&spaces=drive`);
  const listData = await listRes.json();
  if (listData.files && listData.files.length > 0) {
    appFolderIdCache = listData.files[0].id;
    return appFolderIdCache;
  }

  const createRes = await driveFetch(FILES_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: APP_FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' }),
  });
  const created = await createRes.json();
  appFolderIdCache = created.id;
  return appFolderIdCache;
}

async function findFileInAppFolder(name) {
  const folderId = await getOrCreateAppFolder();
  const q = encodeURIComponent(
    `name='${escapeForQuery(name)}' and '${folderId}' in parents and trashed=false`
  );
  const res = await driveFetch(`${FILES_URL}?q=${q}&fields=files(id,name)&spaces=drive`);
  const data = await res.json();
  return data.files && data.files.length > 0 ? data.files[0] : null;
}

async function downloadFileBytes(fileId, resourceKey) {
  const headers = resourceKey ? { 'X-Goog-Drive-Resource-Keys': `${fileId}/${resourceKey}` } : {};
  const res = await driveFetch(`${FILES_URL}/${fileId}?alt=media`, { headers });
  return new Uint8Array(await res.arrayBuffer());
}

async function downloadFileJson(fileId) {
  const res = await driveFetch(`${FILES_URL}/${fileId}?alt=media`);
  return res.json();
}

async function uploadJson(name, existingFileId, obj) {
  const folderId = await getOrCreateAppFolder();
  const json = JSON.stringify(obj, null, 2);

  if (existingFileId) {
    await driveFetch(`${UPLOAD_URL}/${existingFileId}?uploadType=media`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json; charset=UTF-8' },
      body: json,
    });
    return existingFileId;
  }

  const boundary = `pdfnotes-${Math.random().toString(16).slice(2)}`;
  const metadata = { name, parents: [folderId] };
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${json}\r\n--${boundary}--`;
  const res = await driveFetch(`${UPLOAD_URL}?uploadType=multipart&fields=id`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body,
  });
  const created = await res.json();
  return created.id;
}

async function uploadBinary(name, mimeType, bytes) {
  const folderId = await getOrCreateAppFolder();
  const boundary = `pdfnotes-${Math.random().toString(16).slice(2)}`;
  const metadata = { name, parents: [folderId] };
  const head =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`;
  const tail = `\r\n--${boundary}--`;
  const body = new Blob([head, bytes, tail]);
  const res = await driveFetch(`${UPLOAD_URL}?uploadType=multipart&fields=id`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body,
  });
  const created = await res.json();
  return created.id;
}

function annotationsFileNameFor(pdfFileName) {
  const base = pdfFileName.replace(/\.pdf$/i, '');
  return `${base}.annot.json`;
}

// ---------------- Google Picker ----------------

function ensurePickerLoaded() {
  return new Promise((resolve, reject) => {
    if (window.google?.picker) {
      resolve();
      return;
    }
    const waitForGapi = () => {
      if (window.gapi) {
        window.gapi.load('picker', { callback: resolve, onerror: reject });
      } else {
        setTimeout(waitForGapi, 50);
      }
    };
    waitForGapi();
  });
}

// Picker 위젯 안쪽(구글 origin의 iframe)은 CSS로 직접 손댈 수 없지만, 그 iframe을 담고 있는
// 바깥 박스(.picker-dialog)는 우리 페이지 DOM에 그대로 들어오기 때문에 통째로 확대할 수 있다.
// 글자 크기를 키우는 대신 다이얼로그 자체를 확대해서 저시력 학생도 읽기 쉽게 만든다.
const PICKER_SCALE = 1.5;

function enlargePickerDialog() {
  const start = Date.now();
  const timer = setInterval(() => {
    const dialog = document.querySelector('.picker-dialog');
    if (dialog) {
      dialog.style.transform = `scale(${PICKER_SCALE})`;
      dialog.style.transformOrigin = 'center center';
      clearInterval(timer);
      return;
    }
    if (Date.now() - start > 5000) clearInterval(timer);
  }, 50);
}

export async function openPdfDialog() {
  await ensurePickerLoaded();
  const token = await auth.ensureAccessToken();

  return new Promise((resolve) => {
    // 목록형(LIST) 보기: drive.file 스코프에서 구글이 권장하는 모드이기도 하고,
    // 그리드 썸네일보다 파일명이 한 줄로 더 크게 보여 저시력 학생이 읽기 쉽다.
    // setMimeTypes에 지정한 타입만 목록에 보이므로, 폴더 mimetype도 같이 넣어야
    // 폴더 안으로 들어가 탐색할 수 있다(안 넣으면 폴더 자체가 안 보여서 탐색 불가).
    const view = new google.picker.DocsView(google.picker.ViewId.DOCS)
      .setMimeTypes('application/pdf,application/vnd.google-apps.folder')
      .setMode(google.picker.DocsViewMode.LIST)
      .setSelectFolderEnabled(false);

    // 아래에서 다이얼로그를 PICKER_SCALE배로 확대하므로, 확대된 결과가 화면을 벗어나지
    // 않도록 원본 크기를 그만큼 미리 줄여서 요청한다.
    const dialogWidth = Math.min(window.innerWidth - 40, 1400) / PICKER_SCALE;
    const dialogHeight = Math.min(window.innerHeight - 40, 1000) / PICKER_SCALE;

    const picker = new google.picker.PickerBuilder()
      .setOAuthToken(token)
      .setDeveloperKey(GOOGLE_API_KEY)
      .setAppId(GOOGLE_APP_ID)
      .addView(view)
      .setTitle('학습할 PDF 선택')
      .setLocale('ko')
      .setSize(dialogWidth, dialogHeight)
      .setCallback((data) => {
        if (data.action === google.picker.Action.PICKED) {
          const doc = data.docs[0];
          resolve({ fileId: doc.id, name: doc.name, resourceKey: doc.resourceKey || null });
        } else if (data.action === google.picker.Action.CANCEL) {
          resolve(null);
        }
      })
      .build();
    picker.setVisible(true);
    enlargePickerDialog();
  });
}

export async function readPdfFile(fileId, resourceKey) {
  return downloadFileBytes(fileId, resourceKey);
}

export async function loadAnnotations(fileId, fileName) {
  const file = await findFileInAppFolder(annotationsFileNameFor(fileName));
  if (!file) return null;
  return downloadFileJson(file.id);
}

export async function saveAnnotations(fileId, fileName, data) {
  const name = annotationsFileNameFor(fileName);
  const existing = await findFileInAppFolder(name);
  await uploadJson(name, existing ? existing.id : null, { ...data, sourceFileId: fileId, sourceFileName: fileName });
  return true;
}

export async function loadSettings() {
  const file = await findFileInAppFolder(SETTINGS_FILE_NAME);
  const loaded = file ? await downloadFileJson(file.id) : null;
  if (!loaded) return DEFAULT_SETTINGS;
  return {
    ...DEFAULT_SETTINGS,
    ...loaded,
    tools: {
      pen: { ...DEFAULT_SETTINGS.tools.pen, ...(loaded.tools && loaded.tools.pen) },
      highlighter: { ...DEFAULT_SETTINGS.tools.highlighter, ...(loaded.tools && loaded.tools.highlighter) },
      eraser: { ...DEFAULT_SETTINGS.tools.eraser, ...(loaded.tools && loaded.tools.eraser) },
      text: { ...DEFAULT_SETTINGS.tools.text, ...(loaded.tools && loaded.tools.text) },
    },
  };
}

export async function saveSettings(data) {
  const existing = await findFileInAppFolder(SETTINGS_FILE_NAME);
  await uploadJson(SETTINGS_FILE_NAME, existing ? existing.id : null, data);
  return true;
}

export async function exportPdfDialog(defaultFileName) {
  return promptExportFileName(defaultFileName);
}

export async function writePdfFile(fileName, bytes) {
  await uploadBinary(fileName, 'application/pdf', bytes);

  // Drive 업로드와 별개로, 학생이 바로 확인할 수 있도록 브라우저 다운로드도 같이 트리거한다.
  const blobUrl = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
  const link = document.createElement('a');
  link.href = blobUrl;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(blobUrl);

  return true;
}

export async function readKoreanBoldFont() {
  const res = await fetch('assets/fonts/NanumGothicBold.ttf');
  if (!res.ok) return null;
  return new Uint8Array(await res.arrayBuffer());
}
