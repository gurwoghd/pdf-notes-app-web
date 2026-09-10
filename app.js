import * as pdfEngine from './pdfEngine.js?v=a72f8f4';
import * as store from './store.js?v=a72f8f4';
import * as api from './driveApi.js?v=a72f8f4';
import * as auth from './auth.js?v=a72f8f4';
import { strokeSmoothPath, shouldRecordPoint, distancePointToSegment, sampleSweptPath, sampleSmoothPath } from './smoothing.js?v=a72f8f4';
import {
  ZOOM_STEPS, DEFAULT_SCALE, PALETTE, HIGHLIGHTER_PALETTE, WIDTH_PRESETS, MAX_FAVORITES, HIGHLIGHTER_ALPHA,
  TEXT_FONT_FAMILY, TEXT_COLOR, TEXT_SIZE_MIN, TEXT_SIZE_MAX, TEXT_SIZE_STEP, TEXT_LINE_HEIGHT,
  FEEDBACK_FORM_ENDPOINT, USAGE_LOG_ENDPOINT,
} from './constants.js?v=a72f8f4';
import * as PDFLib from './vendor/pdf-lib/pdf-lib.esm.js';

// fontkit is loaded as a classic <script> in index.html (its ESM build imports the
// bare specifier "pako", which the native module loader here cannot resolve), so it
// attaches itself to window.fontkit instead of being imported.
const fontkit = window.fontkit;

const MAX_UNDO_STACK = 50;

const els = {
  app: document.getElementById('app'),
  tabbar: document.getElementById('tabbar'),
  openBtn: document.getElementById('open-btn'),
  emptyOpenBtn: document.getElementById('empty-open-btn'),
  zoomInBtn: document.getElementById('zoom-in-btn'),
  zoomOutBtn: document.getElementById('zoom-out-btn'),
  zoomLevel: document.getElementById('zoom-level'),
  autosaveStatus: document.getElementById('autosave-status'),
  viewer: document.getElementById('viewer'),
  viewerWrap: document.getElementById('viewer-wrap'),
  pageContainer: document.getElementById('page-container'),
  pdfCanvas: document.getElementById('pdf-canvas'),
  committedCanvas: document.getElementById('committed-canvas'),
  activeCanvas: document.getElementById('active-canvas'),
  toolPopup: document.getElementById('tool-popup'),
  prevPageBtn: document.getElementById('prev-page-btn'),
  nextPageBtn: document.getElementById('next-page-btn'),
  pageIndicator: document.getElementById('page-indicator'),
  tocBtn: document.getElementById('toc-btn'),
  tocPopup: document.getElementById('toc-popup'),
  exportBtn: document.getElementById('export-btn'),
  favoriteBtn: document.getElementById('favorite-btn'),
  favoritePopup: document.getElementById('favorite-popup'),
  feedbackBtn: document.getElementById('feedback-btn'),
  feedbackPopup: document.getElementById('feedback-popup'),
  modalBackdrop: document.getElementById('modal-backdrop'),
  signoutBtn: document.getElementById('signout-btn'),
  signinScreen: document.getElementById('signin-screen'),
  signinBtn: document.getElementById('signin-btn'),
  signinStatus: document.getElementById('signin-status'),
};

const textMeasureCtx = document.createElement('canvas').getContext('2d');

const state = {
  settings: null,
  currentTool: 'pen',
  viewport: null,
  docs: [],
  activeIndex: -1,
};

function activeDoc() {
  return state.activeIndex >= 0 ? state.docs[state.activeIndex] : null;
}

let renderToken = 0;
let drawing = false;
let activePointerId = null;
let rawPoints = [];
let eraseDirty = false;
let eraseGestureUndoPushed = false;
let lastErasePoint = null;
let zoomEdit = null;
let pageEdit = null;
let panning = false;
let panPointerId = null;
let panStart = null;
let activeTextEditor = null;
let selection = [];
let selectMode = null;
let selectDragOrigin = null;
let selectDragOffset = { x: 0, y: 0 };
let lassoPoints = null;

// ---------------- editable inline fields (zoom %, page number) ----------------

function wireEditableField(el, { getEditValue, formatDisplay, commit }) {
  function fitWidth() {
    el.size = Math.max(el.value.length, 1);
  }
  function beginEdit() {
    if (!el.readOnly) return;
    el.readOnly = false;
    el.classList.add('editing');
    el.value = getEditValue();
    fitWidth();
    el.select();
  }
  function endEdit(apply) {
    if (el.readOnly) return;
    if (apply) commit(el.value);
    el.readOnly = true;
    el.classList.remove('editing');
    el.value = formatDisplay();
    fitWidth();
  }
  el.addEventListener('click', beginEdit);
  el.addEventListener('input', fitWidth);
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { endEdit(true); el.blur(); e.preventDefault(); }
    else if (e.key === 'Escape') { endEdit(false); el.blur(); e.preventDefault(); }
  });
  el.addEventListener('blur', () => endEdit(true));
  fitWidth();
  return {
    refresh() {
      if (el.readOnly) { el.value = formatDisplay(); fitWidth(); }
    },
  };
}

// ---------------- init ----------------

async function init() {
  state.settings = await api.loadSettings();
  state.currentTool = 'pen';

  wireToolbar();
  wireOutsideClick();
  wirePageNav();
  wireKeyboard();
  wireDrawing();
  wirePanning();

  updateToolButtonsUI();
  updateAppEmptyState();
  renderTabBar();

  const filesToRestore = state.settings.openPdfFiles || [];

  for (const f of filesToRestore) {
    try {
      await openPdf(f);
    } catch (err) {
      console.warn('PDF를 불러오지 못했습니다.', f, err);
    }
  }

  if (state.docs.length > 0) {
    const wantFileId = state.settings.activePdfFileId;
    const idx = wantFileId ? state.docs.findIndex((d) => d.fileId === wantFileId) : 0;
    if (idx >= 0 && idx !== state.activeIndex) {
      await switchToDoc(idx);
    }
  }
}

// ---------------- PDF loading / multi-document tabs ----------------

async function handleOpenClick() {
  const picked = await api.openPdfDialog();
  if (!picked) return;
  await openPdf(picked);
}

async function openPdf({ fileId, name, resourceKey }) {
  const existingIndex = state.docs.findIndex((d) => d.fileId === fileId);
  if (existingIndex !== -1) {
    await switchToDoc(existingIndex);
    return;
  }

  const data = await api.readPdfFile(fileId, resourceKey);
  const pdfDoc = await pdfEngine.loadDocument(data);
  const loadedAnnotations = await api.loadAnnotations(fileId, name);

  const doc = {
    fileId,
    fileName: name,
    resourceKey: resourceKey || null,
    pdfDoc,
    numPages: pdfDoc.numPages,
    currentPage: 1,
    annotations: store.normalizeAnnotations(loadedAnnotations || store.emptyAnnotations()),
    scale: DEFAULT_SCALE,
    undoStack: [],
  };
  state.docs.push(doc);
  await switchToDoc(state.docs.length - 1);
}

async function switchToDoc(index) {
  state.activeIndex = index;
  updateAppEmptyState();
  renderTabBar();
  await renderCurrentPage();
  saveOpenDocsSettings();
}

function closeDoc(index) {
  if (index < 0 || index >= state.docs.length) return;
  state.docs.splice(index, 1);

  if (state.docs.length === 0) {
    state.activeIndex = -1;
    state.viewport = null;
    updateAppEmptyState();
    renderTabBar();
    closePopup();
    closeTocPopup();
    closeFavoritePopup();
    saveOpenDocsSettings();
    return;
  }

  let newActive = state.activeIndex;
  if (index < state.activeIndex) newActive -= 1;
  else if (index === state.activeIndex) newActive = Math.min(index, state.docs.length - 1);
  switchToDoc(newActive);
}

function updateAppEmptyState() {
  els.app.classList.toggle('no-pdf', state.docs.length === 0);
}

function saveOpenDocsSettings() {
  state.settings.openPdfFiles = state.docs.map((d) => ({ fileId: d.fileId, name: d.fileName, resourceKey: d.resourceKey }));
  const doc = activeDoc();
  state.settings.activePdfFileId = doc ? doc.fileId : null;
  api.saveSettings(state.settings);
}

function docDisplayName(fileName) {
  return fileName.replace(/\.pdf$/i, '');
}

function renderTabBar() {
  const bar = els.tabbar;
  bar.innerHTML = '';

  state.docs.forEach((doc, index) => {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'doc-tab' + (index === state.activeIndex ? ' active' : '');
    tab.title = doc.fileName;

    const title = document.createElement('span');
    title.className = 'doc-tab-title';
    title.textContent = docDisplayName(doc.fileName);
    tab.appendChild(title);

    const closeBtn = document.createElement('span');
    closeBtn.className = 'doc-tab-close';
    closeBtn.setAttribute('role', 'button');
    closeBtn.setAttribute('aria-label', '탭 닫기');
    closeBtn.textContent = '✕';
    closeBtn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      closeDoc(index);
    });
    tab.appendChild(closeBtn);

    tab.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      if (index !== state.activeIndex) switchToDoc(index);
    });

    bar.appendChild(tab);
  });

  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'doc-tab-add';
  addBtn.setAttribute('aria-label', 'PDF 추가로 열기');
  addBtn.title = 'PDF 추가로 열기';
  addBtn.textContent = '+';
  addBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); handleOpenClick(); });
  bar.appendChild(addBtn);
}

// ---------------- undo ----------------

function pushUndoSnapshot(doc) {
  doc.undoStack.push(structuredClone(doc.annotations));
  if (doc.undoStack.length > MAX_UNDO_STACK) doc.undoStack.shift();
}

function undo() {
  const doc = activeDoc();
  if (!doc || doc.undoStack.length === 0) return;
  doc.annotations = doc.undoStack.pop();
  selection = [];
  redrawCommitted();
  updateFavoriteUI();
  closeTocPopup();
  closeFavoritePopup();
  persist();
}

// ---------------- page rendering ----------------

async function renderCurrentPage() {
  const doc = activeDoc();
  if (!doc) return;
  finishActiveTextEditor();
  selection = [];
  const myToken = ++renderToken;

  const savedScale = store.getPageScale(doc.annotations, doc.currentPage);
  const scale = savedScale != null ? savedScale : DEFAULT_SCALE;
  doc.scale = scale;
  updateZoomLabel();
  updatePageIndicator();

  const page = await pdfEngine.getPage(doc.pdfDoc, doc.currentPage);
  if (myToken !== renderToken) return;

  const { viewport, cssWidth, cssHeight } = pdfEngine.computeRenderViewport(page, scale);
  state.viewport = viewport;

  els.pageContainer.style.width = `${cssWidth}px`;
  els.pageContainer.style.height = `${cssHeight}px`;

  await pdfEngine.renderPageToCanvas(page, els.pdfCanvas, viewport);
  if (myToken !== renderToken) return;

  pdfEngine.sizeOverlayCanvas(els.committedCanvas, viewport);
  pdfEngine.sizeOverlayCanvas(els.activeCanvas, viewport);

  for (const canvas of [els.pdfCanvas, els.committedCanvas, els.activeCanvas]) {
    canvas.style.width = `${cssWidth}px`;
    canvas.style.height = `${cssHeight}px`;
  }

  redrawCommitted();
  updateFavoriteUI();
  closePopup();
  closeTocPopup();
  closeFavoritePopup();
}

function redrawCommitted() {
  const ctx = els.committedCanvas.getContext('2d');
  ctx.clearRect(0, 0, els.committedCanvas.width, els.committedCanvas.height);

  const doc = activeDoc();
  if (!doc) return;

  for (const stroke of store.getStrokes(doc.annotations, doc.currentPage, 'highlighter')) {
    drawStoredStroke(ctx, stroke, HIGHLIGHTER_ALPHA);
  }
  for (const stroke of store.getStrokes(doc.annotations, doc.currentPage, 'pen')) {
    drawStoredStroke(ctx, stroke, 1);
  }
  for (const t of store.getTexts(doc.annotations, doc.currentPage)) {
    drawStoredText(ctx, t);
  }
  drawSelectionOverlay(ctx, doc);
}

// ---------------- selection / move / lasso ----------------

function drawSelectionOverlay(ctx, doc) {
  if (state.currentTool !== 'select' || selection.length === 0) return;
  ctx.save();
  ctx.strokeStyle = '#1a73e8';
  ctx.lineWidth = 2.5;
  ctx.setLineDash([8, 5]);
  for (const item of selection) {
    const b = getItemBoundsPdf(doc, item);
    if (!b) continue;
    const p1 = pdfEngine.pdfPointToCanvas(state.viewport, b.minX, b.maxY);
    const p2 = pdfEngine.pdfPointToCanvas(state.viewport, b.maxX, b.minY);
    ctx.strokeRect(
      Math.min(p1.x, p2.x) - 6,
      Math.min(p1.y, p2.y) - 6,
      Math.abs(p2.x - p1.x) + 12,
      Math.abs(p2.y - p1.y) + 12,
    );
  }
  ctx.restore();
}

function getItemBoundsPdf(doc, item) {
  if (item.layer === 'text') {
    const t = store.getTexts(doc.annotations, doc.currentPage)[item.index];
    if (!t) return null;
    const b = measureTextBounds(t);
    return { minX: t.x, maxX: t.x + b.width, minY: t.y - b.height, maxY: t.y };
  }
  const strokes = store.getStrokes(doc.annotations, doc.currentPage, item.layer);
  const s = strokes[item.index];
  if (!s) return null;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [x, y] of s.points) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const pad = s.width / 2;
  return { minX: minX - pad, maxX: maxX + pad, minY: minY - pad, maxY: maxY + pad };
}

function getSelectionBoundsPdf(doc) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let any = false;
  for (const item of selection) {
    const b = getItemBoundsPdf(doc, item);
    if (!b) continue;
    any = true;
    minX = Math.min(minX, b.minX);
    maxX = Math.max(maxX, b.maxX);
    minY = Math.min(minY, b.minY);
    maxY = Math.max(maxY, b.maxY);
  }
  return any ? { minX, maxX, minY, maxY } : null;
}

function findHitAtPoint(doc, p) {
  const tol = 14 / state.viewport.scale;

  const texts = store.getTexts(doc.annotations, doc.currentPage);
  for (let i = texts.length - 1; i >= 0; i--) {
    const t = texts[i];
    const b = measureTextBounds(t);
    if (p.x >= t.x - tol && p.x <= t.x + b.width + tol && p.y <= t.y + tol && p.y >= t.y - b.height - tol) {
      return { layer: 'text', index: i };
    }
  }

  for (const layer of ['pen', 'highlighter']) {
    const strokes = store.getStrokes(doc.annotations, doc.currentPage, layer);
    for (let i = strokes.length - 1; i >= 0; i--) {
      const s = strokes[i];
      const pts = s.points.map(([x, y]) => ({ x, y }));
      const effTol = tol + s.width / 2;
      let hit = false;
      if (pts.length === 1) {
        hit = distancePointToSegment(p, pts[0], pts[0]) <= effTol;
      } else {
        for (let k = 0; k < pts.length - 1; k++) {
          if (distancePointToSegment(p, pts[k], pts[k + 1]) <= effTol) { hit = true; break; }
        }
      }
      if (hit) return { layer, index: i };
    }
  }
  return null;
}

function pointInPolygon(pt, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x;
    const yi = poly[i].y;
    const xj = poly[j].x;
    const yj = poly[j].y;
    const intersect = ((yi > pt.y) !== (yj > pt.y))
      && (pt.x < ((xj - xi) * (pt.y - yi)) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function findItemsInLasso(doc, polygon) {
  const found = [];
  const texts = store.getTexts(doc.annotations, doc.currentPage);
  texts.forEach((t, idx) => {
    const b = measureTextBounds(t);
    const center = { x: t.x + b.width / 2, y: t.y - b.height / 2 };
    if (pointInPolygon(center, polygon)) found.push({ layer: 'text', index: idx });
  });
  for (const layer of ['pen', 'highlighter']) {
    const strokes = store.getStrokes(doc.annotations, doc.currentPage, layer);
    strokes.forEach((s, idx) => {
      const anyInside = s.points.some(([x, y]) => pointInPolygon({ x, y }, polygon));
      if (anyInside) found.push({ layer, index: idx });
    });
  }
  return found;
}

function beginSelectPointerDown(e) {
  const doc = activeDoc();
  if (!doc) return;
  const p = pdfEngine.eventToPdfPoint(e, els.activeCanvas, state.viewport);
  const hit = findHitAtPoint(doc, p);

  els.activeCanvas.setPointerCapture(e.pointerId);
  activePointerId = e.pointerId;
  drawing = true;

  if (hit) {
    const alreadySelected = selection.some((s) => s.layer === hit.layer && s.index === hit.index);
    if (!alreadySelected) {
      selection = [hit];
      redrawCommitted();
    }
    selectMode = 'drag';
    selectDragOrigin = p;
    selectDragOffset = { x: 0, y: 0 };
  } else {
    if (selection.length) {
      selection = [];
      redrawCommitted();
    }
    selectMode = 'lasso';
    lassoPoints = [p];
  }
}

function updateSelectPointerMove(e) {
  const doc = activeDoc();
  if (!doc) return;
  const p = pdfEngine.eventToPdfPoint(e, els.activeCanvas, state.viewport);
  if (selectMode === 'drag') {
    selectDragOffset = { x: p.x - selectDragOrigin.x, y: p.y - selectDragOrigin.y };
    drawSelectDragPreview(doc);
  } else if (selectMode === 'lasso') {
    if (shouldRecordPoint(lassoPoints[lassoPoints.length - 1], p, 1)) {
      lassoPoints.push(p);
    }
    drawLassoPreview();
  }
}

function drawSelectDragPreview(doc) {
  const ctx = els.activeCanvas.getContext('2d');
  ctx.clearRect(0, 0, els.activeCanvas.width, els.activeCanvas.height);
  const bounds = getSelectionBoundsPdf(doc);
  if (!bounds) return;
  const p1 = pdfEngine.pdfPointToCanvas(state.viewport, bounds.minX + selectDragOffset.x, bounds.maxY + selectDragOffset.y);
  const p2 = pdfEngine.pdfPointToCanvas(state.viewport, bounds.maxX + selectDragOffset.x, bounds.minY + selectDragOffset.y);
  ctx.save();
  ctx.strokeStyle = '#1a73e8';
  ctx.lineWidth = 3;
  ctx.setLineDash([8, 5]);
  ctx.strokeRect(
    Math.min(p1.x, p2.x) - 6,
    Math.min(p1.y, p2.y) - 6,
    Math.abs(p2.x - p1.x) + 12,
    Math.abs(p2.y - p1.y) + 12,
  );
  ctx.restore();
}

function drawLassoPreview() {
  const ctx = els.activeCanvas.getContext('2d');
  ctx.clearRect(0, 0, els.activeCanvas.width, els.activeCanvas.height);
  if (!lassoPoints || lassoPoints.length < 2) return;
  const pts = lassoPoints.map((p) => pdfEngine.pdfPointToCanvas(state.viewport, p.x, p.y));
  ctx.save();
  ctx.strokeStyle = '#1a73e8';
  ctx.fillStyle = 'rgba(26, 115, 232, 0.12)';
  ctx.lineWidth = 2.5;
  ctx.setLineDash([6, 4]);
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function finishSelectInteraction(doc) {
  clearActiveCanvas();
  if (selectMode === 'drag') {
    const { x: dx, y: dy } = selectDragOffset;
    if (Math.abs(dx) > 0.01 || Math.abs(dy) > 0.01) {
      pushUndoSnapshot(doc);
      for (const item of selection) {
        if (item.layer === 'text') {
          const texts = store.getTexts(doc.annotations, doc.currentPage);
          const t = texts[item.index];
          if (t) { t.x = round2(t.x + dx); t.y = round2(t.y + dy); }
        } else {
          const strokes = store.getStrokes(doc.annotations, doc.currentPage, item.layer);
          const s = strokes[item.index];
          if (s) { s.points = s.points.map(([x, y]) => [round2(x + dx), round2(y + dy)]); }
        }
      }
      redrawCommitted();
      persist();
    }
  } else if (selectMode === 'lasso') {
    if (lassoPoints && lassoPoints.length >= 3) {
      selection = findItemsInLasso(doc, lassoPoints);
    }
    redrawCommitted();
  }
  selectMode = null;
  selectDragOrigin = null;
  lassoPoints = null;
}

function clearSelectionState() {
  selectMode = null;
  selectDragOrigin = null;
  lassoPoints = null;
}

function deleteSelection() {
  const doc = activeDoc();
  if (!doc || selection.length === 0) return;
  pushUndoSnapshot(doc);
  const byLayer = { pen: [], highlighter: [], text: [] };
  for (const item of selection) byLayer[item.layer].push(item.index);
  if (byLayer.pen.length) store.removeStrokes(doc.annotations, doc.currentPage, 'pen', byLayer.pen);
  if (byLayer.highlighter.length) store.removeStrokes(doc.annotations, doc.currentPage, 'highlighter', byLayer.highlighter);
  if (byLayer.text.length) store.removeTexts(doc.annotations, doc.currentPage, byLayer.text);
  selection = [];
  redrawCommitted();
  persist();
}

function drawStoredText(ctx, entry) {
  const canvasFontSize = pdfEngine.pdfWidthToCanvas(state.viewport, entry.size);
  const origin = pdfEngine.pdfPointToCanvas(state.viewport, entry.x, entry.y);
  const lineHeight = canvasFontSize * TEXT_LINE_HEIGHT;
  ctx.save();
  ctx.font = `bold ${canvasFontSize}px ${TEXT_FONT_FAMILY}`;
  ctx.fillStyle = TEXT_COLOR;
  ctx.textBaseline = 'top';
  entry.text.split('\n').forEach((line, i) => {
    ctx.fillText(line, origin.x, origin.y + i * lineHeight);
  });
  ctx.restore();
}

function measureTextBounds(entry) {
  textMeasureCtx.font = `bold ${entry.size}px ${TEXT_FONT_FAMILY}`;
  const lines = entry.text.split('\n');
  let maxWidth = 0;
  for (const line of lines) {
    const w = textMeasureCtx.measureText(line).width;
    if (w > maxWidth) maxWidth = w;
  }
  const lineHeight = entry.size * TEXT_LINE_HEIGHT;
  return { width: maxWidth, height: lines.length * lineHeight };
}

function updateFavoriteUI() {
  const doc = activeDoc();
  const active = !!doc && store.isFavorite(doc.annotations, doc.currentPage);
  els.viewerWrap.classList.toggle('favorite', active);
  els.favoriteBtn.classList.toggle('active', active);
}

function drawStoredStroke(ctx, stroke, alpha) {
  const points = stroke.points.map(([x, y]) => pdfEngine.pdfPointToCanvas(state.viewport, x, y));
  const width = pdfEngine.pdfWidthToCanvas(state.viewport, stroke.width);
  strokeSmoothPath(ctx, points, { color: stroke.color, width, alpha });
}

function clearActiveCanvas() {
  const ctx = els.activeCanvas.getContext('2d');
  ctx.clearRect(0, 0, els.activeCanvas.width, els.activeCanvas.height);
}

// ---------------- tool cursor ----------------

function buildDotCursor(color) {
  const size = 52;
  const c = size / 2;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">`
    + `<circle cx="${c}" cy="${c}" r="16" fill="${color}" fill-opacity="0.7" stroke="#000000" stroke-width="2"/>`
    + `<circle cx="${c}" cy="${c}" r="2" fill="#000000"/>`
    + `</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${c} ${c}, crosshair`;
}

function buildHighlighterCursor(color) {
  const w = 64;
  const h = 36;
  const cx = w / 2;
  const cy = h / 2;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">`
    + `<rect x="2" y="2" width="${w - 4}" height="${h - 4}" rx="7" fill="${color}" fill-opacity="0.6" stroke="#000000" stroke-width="2"/>`
    + `<circle cx="${cx}" cy="${cy}" r="2" fill="#000000"/>`
    + `</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${cx} ${cy}, crosshair`;
}

function buildEraserCursor() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48">`
    + `<g transform="rotate(-25 24 24)">`
    + `<rect x="9" y="18" width="30" height="18" rx="4" fill="#ffffff" stroke="#000000" stroke-width="2"/>`
    + `<rect x="9" y="18" width="30" height="9.2" rx="4" fill="#ffb703" stroke="none"/>`
    + `<line x1="9" y1="27.2" x2="39" y2="27.2" stroke="#000000" stroke-width="2"/>`
    + `</g></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") 24 24, auto`;
}

function buildTextCursor() {
  const size = 48;
  const c = size / 2;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">`
    + `<text x="${c}" y="${c + 13}" font-family="Segoe UI, Malgun Gothic, sans-serif" font-size="36" font-weight="900" `
    + `text-anchor="middle" fill="#000000" stroke="#ffffff" stroke-width="3.5" paint-order="stroke" stroke-linejoin="round">T</text>`
    + `</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${c} ${c}, text`;
}

function updateCanvasCursor() {
  if (state.currentTool === 'eraser') {
    els.activeCanvas.style.cursor = buildEraserCursor();
  } else if (state.currentTool === 'highlighter') {
    els.activeCanvas.style.cursor = buildHighlighterCursor(state.settings.tools.highlighter.color);
  } else if (state.currentTool === 'text') {
    els.activeCanvas.style.cursor = buildTextCursor();
  } else if (state.currentTool === 'select') {
    els.activeCanvas.style.cursor = 'default';
  } else {
    els.activeCanvas.style.cursor = buildDotCursor(state.settings.tools.pen.color);
  }
}

// ---------------- drawing interaction ----------------

function wireDrawing() {
  els.activeCanvas.addEventListener('pointerdown', onPointerDown);
  els.activeCanvas.addEventListener('pointermove', onPointerMove);
  els.activeCanvas.addEventListener('pointerup', onPointerUp);
  els.activeCanvas.addEventListener('pointercancel', onPointerCancel);
  els.activeCanvas.addEventListener('pointerleave', () => {
    if (!drawing) clearActiveCanvas();
  });

  // Safety net: if the mouse button is released outside the window (or the
  // window loses focus) while a stroke/erase is in progress, the canvas can
  // be left holding pointer capture forever, silently swallowing every
  // future click anywhere in the app. Force a clean release in that case.
  window.addEventListener('blur', forceEndDrawing);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) forceEndDrawing();
  });
}

function forceEndDrawing() {
  finishActiveTextEditor();
  if (panning) endPanning();
  if (!drawing) return;
  try { els.activeCanvas.releasePointerCapture(activePointerId); } catch { /* noop */ }
  drawing = false;
  activePointerId = null;
  rawPoints = [];
  eraseDirty = false;
  eraseGestureUndoPushed = false;
  lastErasePoint = null;
  clearSelectionState();
  clearActiveCanvas();
}

function onPointerDown(e) {
  const doc = activeDoc();
  if (!doc || e.button !== 0) return;

  if (state.currentTool === 'text') {
    e.preventDefault();
    beginTextInput(e);
    return;
  }

  if (state.currentTool === 'select') {
    e.preventDefault();
    beginSelectPointerDown(e);
    return;
  }

  els.activeCanvas.setPointerCapture(e.pointerId);
  activePointerId = e.pointerId;
  drawing = true;

  if (state.currentTool === 'eraser') {
    eraseDirty = false;
    eraseGestureUndoPushed = false;
    lastErasePoint = null;
    eraseAtEvent(e);
  } else {
    rawPoints = [];
    rawPoints.push(pdfEngine.eventToPdfPoint(e, els.activeCanvas, state.viewport));
    redrawActiveStroke();
  }
  e.preventDefault();
}

function onPointerMove(e) {
  if (!activeDoc()) return;
  if (!drawing) {
    if (state.currentTool === 'eraser') drawEraserPreview(e);
    return;
  }
  if (state.currentTool === 'eraser') {
    eraseAtEvent(e);
    drawEraserPreview(e);
  } else if (state.currentTool === 'select') {
    updateSelectPointerMove(e);
  } else {
    const p = pdfEngine.eventToPdfPoint(e, els.activeCanvas, state.viewport);
    if (shouldRecordPoint(rawPoints[rawPoints.length - 1], p, 0.75)) {
      rawPoints.push(p);
      redrawActiveStroke();
    }
  }
}

function onPointerUp(e) {
  if (!drawing) return;
  drawing = false;
  activePointerId = null;
  try { els.activeCanvas.releasePointerCapture(e.pointerId); } catch { /* noop */ }

  const doc = activeDoc();
  if (!doc) {
    clearActiveCanvas();
    rawPoints = [];
    clearSelectionState();
    return;
  }

  if (state.currentTool === 'eraser') {
    clearActiveCanvas();
    lastErasePoint = null;
    if (eraseDirty) {
      eraseDirty = false;
      persist();
    }
  } else if (state.currentTool === 'select') {
    finishSelectInteraction(doc);
  } else {
    if (rawPoints.length >= 1) {
      const toolSettings = state.settings.tools[state.currentTool];
      const stroke = {
        color: toolSettings.color,
        width: toolSettings.width,
        points: rawPoints.map((p) => [round2(p.x), round2(p.y)]),
      };
      pushUndoSnapshot(doc);
      store.addStroke(doc.annotations, doc.currentPage, state.currentTool, stroke);
      redrawCommitted();
      persist();
    }
    clearActiveCanvas();
    rawPoints = [];
  }
}

function onPointerCancel(e) {
  drawing = false;
  activePointerId = null;
  try { els.activeCanvas.releasePointerCapture(e.pointerId); } catch { /* noop */ }
  clearActiveCanvas();
  rawPoints = [];
  eraseDirty = false;
  eraseGestureUndoPushed = false;
  lastErasePoint = null;
  clearSelectionState();
}

function redrawActiveStroke() {
  const ctx = els.activeCanvas.getContext('2d');
  ctx.clearRect(0, 0, els.activeCanvas.width, els.activeCanvas.height);
  const points = rawPoints.map((p) => pdfEngine.pdfPointToCanvas(state.viewport, p.x, p.y));
  const toolSettings = state.settings.tools[state.currentTool];
  const width = pdfEngine.pdfWidthToCanvas(state.viewport, toolSettings.width);
  strokeSmoothPath(ctx, points, {
    color: toolSettings.color,
    width,
    alpha: state.currentTool === 'highlighter' ? HIGHLIGHTER_ALPHA : 1,
  });
}

function eraseAtEvent(e) {
  const doc = activeDoc();
  if (!doc) return;
  const p = pdfEngine.eventToPdfPoint(e, els.activeCanvas, state.viewport);
  const radius = state.settings.tools.eraser.width / 2;
  // Sample along the swept path (not just the current point) so a fast swipe
  // can't skip over a stroke that falls between two pointermove samples.
  const samples = sampleSweptPath(lastErasePoint, p, radius * 0.5);
  lastErasePoint = p;
  let changed = false;

  for (const layer of ['pen', 'highlighter']) {
    const strokes = store.getStrokes(doc.annotations, doc.currentPage, layer);
    const hitIdx = [];
    strokes.forEach((s, idx) => {
      const pts = s.points.map(([x, y]) => ({ x, y }));
      let hit = false;
      for (const sp of samples) {
        if (pts.length === 1) {
          if (distancePointToSegment(sp, pts[0], pts[0]) <= radius) { hit = true; break; }
        } else {
          for (let i = 0; i < pts.length - 1; i++) {
            if (distancePointToSegment(sp, pts[i], pts[i + 1]) <= radius) { hit = true; break; }
          }
        }
        if (hit) break;
      }
      if (hit) hitIdx.push(idx);
    });
    if (hitIdx.length) {
      if (!eraseGestureUndoPushed) {
        pushUndoSnapshot(doc);
        eraseGestureUndoPushed = true;
      }
      store.removeStrokes(doc.annotations, doc.currentPage, layer, hitIdx);
      changed = true;
    }
  }

  const texts = store.getTexts(doc.annotations, doc.currentPage);
  const hitTextIdx = [];
  texts.forEach((t, idx) => {
    const b = measureTextBounds(t);
    const cx = t.x + b.width / 2;
    const cy = t.y - b.height / 2;
    const effRadius = Math.sqrt((b.width / 2) ** 2 + (b.height / 2) ** 2);
    for (const sp of samples) {
      const dx = sp.x - cx;
      const dy = sp.y - cy;
      if (Math.sqrt(dx * dx + dy * dy) <= radius + effRadius) {
        hitTextIdx.push(idx);
        break;
      }
    }
  });
  if (hitTextIdx.length) {
    if (!eraseGestureUndoPushed) {
      pushUndoSnapshot(doc);
      eraseGestureUndoPushed = true;
    }
    store.removeTexts(doc.annotations, doc.currentPage, hitTextIdx);
    changed = true;
  }

  if (changed) {
    redrawCommitted();
    eraseDirty = true;
  }
}

function sampleUnderlyingColor(cx, cy) {
  try {
    let data = els.committedCanvas.getContext('2d').getImageData(cx, cy, 1, 1).data;
    if (data[3] === 0) {
      data = els.pdfCanvas.getContext('2d').getImageData(cx, cy, 1, 1).data;
    }
    return { r: data[0], g: data[1], b: data[2] };
  } catch {
    return { r: 255, g: 255, b: 255 };
  }
}

function drawEraserPreview(e) {
  const ctx = els.activeCanvas.getContext('2d');
  ctx.clearRect(0, 0, els.activeCanvas.width, els.activeCanvas.height);
  const rect = els.activeCanvas.getBoundingClientRect();
  const scaleX = els.activeCanvas.width / rect.width;
  const cx = (e.clientX - rect.left) * scaleX;
  const cy = (e.clientY - rect.top) * scaleX;
  const r = pdfEngine.pdfWidthToCanvas(state.viewport, state.settings.tools.eraser.width) / 2;

  const under = sampleUnderlyingColor(Math.round(cx), Math.round(cy));
  const strokeColor = `rgb(${255 - under.r}, ${255 - under.g}, ${255 - under.b})`;

  ctx.save();
  ctx.strokeStyle = strokeColor;
  ctx.lineWidth = 4;
  ctx.setLineDash([8, 6]);
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// ---------------- text tool ----------------

function beginTextInput(e) {
  const doc = activeDoc();
  if (!doc) return;
  finishActiveTextEditor();

  const p = pdfEngine.eventToPdfPoint(e, els.activeCanvas, state.viewport);
  const rect = els.activeCanvas.getBoundingClientRect();
  const cssPerBackingX = rect.width / els.activeCanvas.width;
  const cssPerBackingY = rect.height / els.activeCanvas.height;
  const canvasPoint = pdfEngine.pdfPointToCanvas(state.viewport, p.x, p.y);
  const cssX = canvasPoint.x * cssPerBackingX;
  const cssY = canvasPoint.y * cssPerBackingY;

  const fontSize = state.settings.tools.text.size;
  const canvasFontSize = pdfEngine.pdfWidthToCanvas(state.viewport, fontSize);
  const cssFontSize = canvasFontSize * cssPerBackingX;

  const textarea = document.createElement('textarea');
  textarea.className = 'text-input-overlay';
  textarea.rows = 1;
  textarea.style.left = `${cssX}px`;
  textarea.style.top = `${cssY}px`;
  textarea.style.fontSize = `${cssFontSize}px`;
  textarea.style.lineHeight = String(TEXT_LINE_HEIGHT);

  els.pageContainer.appendChild(textarea);

  const autoResize = () => {
    textarea.style.height = 'auto';
    textarea.style.height = `${textarea.scrollHeight}px`;
  };
  textarea.addEventListener('input', autoResize);
  autoResize();

  textarea.addEventListener('keydown', (ke) => {
    if (ke.key === 'Escape') {
      ke.preventDefault();
      cancelActiveTextEditor();
    }
  });
  textarea.addEventListener('blur', () => commitActiveTextEditor());

  activeTextEditor = { el: textarea, pdfPoint: p, fontSize };
  textarea.focus();
}

function commitActiveTextEditor() {
  if (!activeTextEditor) return;
  const { el, pdfPoint, fontSize } = activeTextEditor;
  const text = el.value.trim();
  el.remove();
  activeTextEditor = null;
  if (!text) return;

  const doc = activeDoc();
  if (!doc) return;
  pushUndoSnapshot(doc);
  store.addText(doc.annotations, doc.currentPage, {
    x: round2(pdfPoint.x),
    y: round2(pdfPoint.y),
    size: fontSize,
    text,
  });
  redrawCommitted();
  persist();
}

function cancelActiveTextEditor() {
  if (!activeTextEditor) return;
  activeTextEditor.el.remove();
  activeTextEditor = null;
}

function finishActiveTextEditor() {
  if (activeTextEditor) commitActiveTextEditor();
}

function adjustTextSize(delta) {
  const cur = state.settings.tools.text.size;
  const next = Math.min(Math.max(cur + delta, TEXT_SIZE_MIN), TEXT_SIZE_MAX);
  if (next === cur) return;
  state.settings.tools.text.size = next;
  api.saveSettings(state.settings);
  openToolPopup('text');
}

// ---------------- pan (Ctrl + drag) ----------------

function wirePanning() {
  els.viewerWrap.addEventListener('pointerdown', (e) => {
    if (!e.ctrlKey || e.button !== 0 || !activeDoc()) return;
    e.preventDefault();
    e.stopPropagation();
    startPanning(e);
  }, true);
  els.viewerWrap.addEventListener('pointermove', (e) => {
    if (!panning) return;
    updatePanning(e);
  }, true);
  els.viewerWrap.addEventListener('pointerup', (e) => {
    if (!panning) return;
    e.stopPropagation();
    endPanning();
  }, true);
  els.viewerWrap.addEventListener('pointercancel', () => {
    if (panning) endPanning();
  }, true);

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Control' && activeDoc() && !panning) {
      els.activeCanvas.style.cursor = 'grab';
      els.viewer.style.cursor = 'grab';
    }
  });
  window.addEventListener('keyup', (e) => {
    if (e.key === 'Control') {
      if (panning) endPanning();
      els.viewer.style.cursor = '';
      updateCanvasCursor();
    }
  });
}

function startPanning(e) {
  finishActiveTextEditor();
  panning = true;
  panPointerId = e.pointerId;
  panStart = { x: e.clientX, y: e.clientY, scrollLeft: els.viewer.scrollLeft, scrollTop: els.viewer.scrollTop };
  try { els.viewerWrap.setPointerCapture(e.pointerId); } catch { /* noop */ }
  els.activeCanvas.style.cursor = 'grabbing';
  els.viewer.style.cursor = 'grabbing';
}

function updatePanning(e) {
  if (!panStart) return;
  els.viewer.scrollLeft = panStart.scrollLeft - (e.clientX - panStart.x);
  els.viewer.scrollTop = panStart.scrollTop - (e.clientY - panStart.y);
}

function endPanning() {
  if (panPointerId != null) {
    try { els.viewerWrap.releasePointerCapture(panPointerId); } catch { /* noop */ }
  }
  panning = false;
  panPointerId = null;
  panStart = null;
  els.viewer.style.cursor = '';
  updateCanvasCursor();
}

// ---------------- autosave ----------------

async function persist() {
  const doc = activeDoc();
  if (!doc) return;
  setStatus('저장 중…', 'saving');
  try {
    await api.saveAnnotations(doc.fileId, doc.fileName, doc.annotations);
    setStatus('자동저장됨', 'ok');
  } catch (err) {
    console.error('필기 저장 실패', err);
    setStatus('저장 실패', 'error');
  }
}

function setStatus(text, mode) {
  els.autosaveStatus.textContent = text;
  els.autosaveStatus.classList.toggle('saving', mode === 'saving');
  els.autosaveStatus.style.color = mode === 'error' ? 'var(--danger)' : '';
}

// ---------------- annotated PDF export ----------------

async function exportAnnotatedPdf() {
  const doc = activeDoc();
  if (!doc) return;
  setStatus('내보내는 중…', 'saving');
  try {
    const defaultName = `${docDisplayName(doc.fileName)}_필기포함.pdf`;
    const targetName = await api.exportPdfDialog(defaultName);
    if (!targetName) {
      setStatus('자동저장됨', 'ok');
      return;
    }

    const outBytes = await buildAnnotatedPdfBytes(doc);
    await api.writePdfFile(targetName, outBytes);
    setStatus('내보내기 완료', 'ok');
  } catch (err) {
    console.error('PDF 내보내기 실패', err);
    setStatus('내보내기 실패', 'error');
  }
}

async function buildAnnotatedPdfBytes(doc) {
  const originalBytes = await api.readPdfFile(doc.fileId, doc.resourceKey);
  const outDoc = await PDFLib.PDFDocument.load(originalBytes);
  const pages = outDoc.getPages();

  const hasAnyText = Object.values(doc.annotations.pages).some((p) => p.text && p.text.length);
  const textFont = hasAnyText ? await embedTextFont(outDoc) : null;

  for (const [pageKey, pageData] of Object.entries(doc.annotations.pages)) {
    const page = pages[Number(pageKey) - 1];
    if (!page) continue;

    for (const stroke of pageData.highlighter || []) {
      drawStrokeOnPdfPage(page, stroke, HIGHLIGHTER_ALPHA);
    }
    for (const stroke of pageData.pen || []) {
      drawStrokeOnPdfPage(page, stroke, 1);
    }
    if (textFont) {
      for (const t of pageData.text || []) {
        drawTextOnPdfPage(page, t, textFont);
      }
    }
  }

  return outDoc.save();
}

async function embedTextFont(outDoc) {
  try {
    const fontBytes = await api.readKoreanBoldFont();
    if (fontBytes) {
      outDoc.registerFontkit(fontkit);
      return await outDoc.embedFont(fontBytes, { subset: true });
    }
  } catch (err) {
    console.warn('한글 폰트를 불러오지 못했습니다. 기본 폰트로 대체합니다.', err);
  }
  return outDoc.embedFont(PDFLib.StandardFonts.HelveticaBold);
}

function drawTextOnPdfPage(page, entry, font) {
  const lineHeight = entry.size * TEXT_LINE_HEIGHT;
  entry.text.split('\n').forEach((line, i) => {
    if (!line) return;
    const baselineY = entry.y - i * lineHeight - entry.size * 0.8;
    try {
      page.drawText(line, {
        x: entry.x,
        y: baselineY,
        size: entry.size,
        font,
        color: PDFLib.rgb(0, 0, 0),
      });
    } catch (err) {
      console.warn('텍스트를 PDF에 표시하지 못했습니다.', err);
    }
  });
}

function drawStrokeOnPdfPage(page, stroke, alpha) {
  const dense = sampleSmoothPath(stroke.points.map(([x, y]) => ({ x, y })), 8);
  const color = hexToRgbColor(stroke.color);
  const thickness = Math.max(stroke.width, 0.5);

  if (dense.length === 1) {
    page.drawEllipse({
      x: dense[0].x,
      y: dense[0].y,
      xScale: thickness / 2,
      yScale: thickness / 2,
      color,
      opacity: alpha,
    });
    return;
  }

  for (let i = 0; i < dense.length - 1; i++) {
    page.drawLine({
      start: dense[i],
      end: dense[i + 1],
      thickness,
      color,
      opacity: alpha,
      lineCap: PDFLib.LineCapStyle.Round,
    });
  }
}

function hexToRgbColor(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  return PDFLib.rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

// ---------------- toolbar ----------------

function wireToolbar() {
  els.openBtn.addEventListener('pointerdown', handleOpenClick);
  els.emptyOpenBtn.addEventListener('pointerdown', handleOpenClick);

  document.querySelectorAll('.tool-btn').forEach((btn) => {
    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      onToolButtonClick(btn.dataset.tool);
    });
  });

  els.zoomInBtn.addEventListener('pointerdown', () => changeZoom(1));
  els.zoomOutBtn.addEventListener('pointerdown', () => changeZoom(-1));

  els.tocBtn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    onTocButtonClick();
  });

  els.exportBtn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    exportAnnotatedPdf();
  });

  els.favoriteBtn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    onFavoriteButtonClick();
  });

  els.feedbackBtn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    onFeedbackButtonClick();
  });

  els.signoutBtn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    auth.signOut();
    window.location.reload();
  });

  zoomEdit = wireEditableField(els.zoomLevel, {
    getEditValue: () => {
      const doc = activeDoc();
      return String(Math.round((doc ? doc.scale : DEFAULT_SCALE) * 100));
    },
    formatDisplay: () => {
      const doc = activeDoc();
      return `${Math.round((doc ? doc.scale : DEFAULT_SCALE) * 100)}%`;
    },
    commit: (raw) => {
      const doc = activeDoc();
      if (!doc) return;
      const n = parseInt(String(raw).replace(/[^0-9]/g, ''), 10);
      if (!Number.isFinite(n) || n <= 0) return;
      const newScale = Math.min(Math.max(n, 10), 1000) / 100;
      if (newScale === doc.scale) return;
      store.setPageScale(doc.annotations, doc.currentPage, newScale);
      renderCurrentPage();
      persist();
    },
  });
}

function onToolButtonClick(tool) {
  finishActiveTextEditor();
  closeTocPopup();
  closeFavoritePopup();
  closeFeedbackPopup();

  if (tool === 'select') {
    closePopup();
    if (state.currentTool !== 'select') {
      state.currentTool = 'select';
      updateToolButtonsUI();
    }
    return;
  }

  if (state.currentTool !== tool) {
    if (state.currentTool === 'select' && selection.length) {
      selection = [];
      redrawCommitted();
    }
    state.currentTool = tool;
    updateToolButtonsUI();
  }
  openToolPopup(tool);
}

function updateToolButtonsUI() {
  document.querySelectorAll('.tool-btn').forEach((btn) => {
    btn.classList.toggle('selected', btn.dataset.tool === state.currentTool);
  });
  document.getElementById('pen-btn').style.color = state.settings.tools.pen.color;
  document.getElementById('highlighter-btn').style.color = state.settings.tools.highlighter.color;
  updateCanvasCursor();
}

function changeZoom(direction) {
  const doc = activeDoc();
  if (!doc) return;
  const idx = nearestZoomIndex(doc.scale);
  const newIdx = Math.min(Math.max(idx + direction, 0), ZOOM_STEPS.length - 1);
  const newScale = ZOOM_STEPS[newIdx];
  if (newScale === doc.scale) return;

  store.setPageScale(doc.annotations, doc.currentPage, newScale);
  renderCurrentPage();
  persist();
}

function nearestZoomIndex(scale) {
  let best = 0;
  let bestDiff = Infinity;
  ZOOM_STEPS.forEach((s, i) => {
    const diff = Math.abs(s - scale);
    if (diff < bestDiff) { bestDiff = diff; best = i; }
  });
  return best;
}

function updateZoomLabel() {
  zoomEdit.refresh();
}

// ---------------- tool popup ----------------

function openToolPopup(tool) {
  const popup = els.toolPopup;
  popup.innerHTML = '';
  popup.dataset.tool = tool;

  popup.appendChild(buildPopupCloseButton(closePopup));

  if (tool === 'pen' || tool === 'highlighter') {
    popup.appendChild(buildFavoritesSection(tool));
    popup.appendChild(buildPaletteSection(tool));
  }
  if (tool === 'text') {
    popup.appendChild(buildTextSizeSection());
  } else {
    popup.appendChild(buildWidthSection(tool));
  }

  popup.hidden = false;
  showModalBackdrop();
}

function closePopup() {
  els.toolPopup.hidden = true;
  els.toolPopup.dataset.tool = '';
  hideModalBackdropIfNoneOpen();
}

function buildPopupCloseButton(onClose) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'popup-close-btn';
  btn.setAttribute('aria-label', '닫기');
  btn.title = '닫기';
  btn.textContent = '✕';
  btn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    onClose();
  });
  return btn;
}

function buildFavoritesSection(tool) {
  const wrap = document.createElement('div');
  const label = document.createElement('div');
  label.className = 'popup-label';
  label.textContent = '즐겨찾기';
  wrap.appendChild(label);

  const row = document.createElement('div');
  row.className = 'popup-row';
  const favorites = state.settings.tools[tool].favorites;
  const currentColor = state.settings.tools[tool].color;

  for (let i = 0; i < MAX_FAVORITES; i++) {
    const color = favorites[i];
    const b = document.createElement('button');
    b.type = 'button';
    if (color) {
      b.className = 'swatch' + (color === currentColor ? ' selected' : '');
      b.style.background = color;
      b.setAttribute('aria-label', `즐겨찾기 색상`);
      b.title = '즐겨찾기 색상';
      b.addEventListener('pointerdown', (e) => { e.preventDefault(); selectColor(tool, color, false); });
    } else {
      b.className = 'swatch empty';
      b.disabled = true;
      b.setAttribute('aria-label', '빈 즐겨찾기 칸');
    }
    row.appendChild(b);
  }
  wrap.appendChild(row);
  return wrap;
}

function buildPaletteSection(tool) {
  const wrap = document.createElement('div');
  const label = document.createElement('div');
  label.className = 'popup-label';
  label.textContent = '색상';
  wrap.appendChild(label);

  const row = document.createElement('div');
  row.className = 'popup-row';
  const palette = tool === 'pen' ? PALETTE : HIGHLIGHTER_PALETTE;
  const currentColor = state.settings.tools[tool].color;

  palette.forEach((color) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'swatch' + (color === currentColor ? ' selected' : '');
    b.style.background = color;
    if (color === '#ffffff') b.style.borderColor = '#888';
    b.setAttribute('aria-label', `색상 ${color}`);
    b.title = color;
    b.addEventListener('pointerdown', (e) => { e.preventDefault(); selectColor(tool, color, true); });
    row.appendChild(b);
  });

  wrap.appendChild(row);
  return wrap;
}

function buildWidthSection(tool) {
  const wrap = document.createElement('div');
  const label = document.createElement('div');
  label.className = 'popup-label';
  label.textContent = '굵기';
  wrap.appendChild(label);

  const row = document.createElement('div');
  row.className = 'popup-row';
  const dotSizes = { thin: 14, normal: 26, bold: 40 };
  const currentWidth = state.settings.tools[tool].width;

  WIDTH_PRESETS[tool].forEach((preset) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'width-btn' + (preset.value === currentWidth ? ' selected' : '');
    b.setAttribute('aria-label', preset.label);
    b.title = preset.label;
    const dot = document.createElement('span');
    dot.className = 'dot';
    const size = dotSizes[preset.key];
    dot.style.width = `${size}px`;
    dot.style.height = `${size}px`;
    if (tool === 'pen' || tool === 'highlighter') {
      dot.style.background = state.settings.tools[tool].color;
    }
    b.appendChild(dot);
    b.addEventListener('pointerdown', (e) => { e.preventDefault(); selectWidth(tool, preset.value); });
    row.appendChild(b);
  });

  wrap.appendChild(row);
  return wrap;
}

function buildTextSizeSection() {
  const wrap = document.createElement('div');
  const label = document.createElement('div');
  label.className = 'popup-label';
  label.textContent = '글자 크기';
  wrap.appendChild(label);

  const row = document.createElement('div');
  row.className = 'popup-row text-size-row';
  const current = state.settings.tools.text.size;

  const minusBtn = document.createElement('button');
  minusBtn.type = 'button';
  minusBtn.className = 'text-size-btn';
  minusBtn.textContent = '−';
  minusBtn.setAttribute('aria-label', '글자 크기 줄이기');
  minusBtn.disabled = current <= TEXT_SIZE_MIN;
  minusBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); adjustTextSize(-TEXT_SIZE_STEP); });

  const display = document.createElement('div');
  display.className = 'text-size-display';
  display.textContent = `${current}pt`;

  const plusBtn = document.createElement('button');
  plusBtn.type = 'button';
  plusBtn.className = 'text-size-btn';
  plusBtn.textContent = '+';
  plusBtn.setAttribute('aria-label', '글자 크기 키우기');
  plusBtn.disabled = current >= TEXT_SIZE_MAX;
  plusBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); adjustTextSize(TEXT_SIZE_STEP); });

  row.appendChild(minusBtn);
  row.appendChild(display);
  row.appendChild(plusBtn);
  wrap.appendChild(row);
  return wrap;
}

function selectColor(tool, color, addToFavorites) {
  state.settings.tools[tool].color = color;
  if (addToFavorites) {
    const favs = state.settings.tools[tool].favorites;
    if (!favs.includes(color)) {
      favs.push(color);
      if (favs.length > MAX_FAVORITES) favs.shift();
    }
  }
  api.saveSettings(state.settings);
  updateToolButtonsUI();
  openToolPopup(tool);
}

function selectWidth(tool, value) {
  state.settings.tools[tool].width = value;
  api.saveSettings(state.settings);
  openToolPopup(tool);
}

function wireOutsideClick() {
  document.addEventListener('pointerdown', (e) => {
    if (!els.toolPopup.hidden
      && !els.toolPopup.contains(e.target)
      && !(e.target.closest && e.target.closest('.tool-btn'))) {
      closePopup();
    }
    if (!els.tocPopup.hidden
      && !els.tocPopup.contains(e.target)
      && !(e.target.closest && e.target.closest('#toc-btn'))) {
      closeTocPopup();
    }
    if (!els.favoritePopup.hidden
      && !els.favoritePopup.contains(e.target)
      && !(e.target.closest && e.target.closest('#favorite-btn'))) {
      closeFavoritePopup();
    }
    if (!els.feedbackPopup.hidden
      && !els.feedbackPopup.contains(e.target)
      && !(e.target.closest && e.target.closest('#feedback-btn'))) {
      closeFeedbackPopup();
    }
  }, true);
}

// ---------------- table of contents (floating popup) ----------------

function onTocButtonClick() {
  if (!activeDoc()) return;
  if (!els.tocPopup.hidden) {
    closeTocPopup();
  } else {
    finishActiveTextEditor();
    closePopup();
    closeFavoritePopup();
    closeFeedbackPopup();
    openTocPopup();
  }
}

async function openTocPopup() {
  const doc = activeDoc();
  if (!doc) return;
  const popup = els.tocPopup;
  popup.innerHTML = '';
  popup.appendChild(buildPopupCloseButton(closeTocPopup));
  const loading = document.createElement('div');
  loading.className = 'popup-label';
  loading.textContent = '목차 불러오는 중…';
  popup.appendChild(loading);
  popup.hidden = false;
  showModalBackdrop();

  const outline = await doc.pdfDoc.getOutline();
  if (activeDoc() !== doc || popup.hidden) return;

  renderTocPopupContent(outline);
}

function renderTocPopupContent(outline) {
  const popup = els.tocPopup;
  popup.innerHTML = '';
  popup.appendChild(buildPopupCloseButton(closeTocPopup));

  const left = document.createElement('div');
  left.className = 'popup-col-left';
  const addLabel = document.createElement('div');
  addLabel.className = 'toc-section-label';
  addLabel.style.margin = '0 0 4px';
  addLabel.textContent = '새 목차 추가';
  left.appendChild(addLabel);
  left.appendChild(buildTocAddRow());
  left.appendChild(buildCustomTocSection());
  popup.appendChild(left);

  const right = document.createElement('div');
  right.className = 'popup-col-right';
  popup.appendChild(right);

  (async () => {
    if (!outline || outline.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'popup-label';
      empty.textContent = '이 PDF에는 목차 정보가 없습니다.';
      right.appendChild(empty);
    } else {
      const list = document.createElement('div');
      list.className = 'toc-list';
      await buildTocItems(outline, list, 0);
      if (popup.hidden) return;
      right.appendChild(list);
    }
  })();
}

function buildCustomTocSection() {
  const wrap = document.createElement('div');
  const doc = activeDoc();
  if (!doc) return wrap;

  const entries = store.getCustomToc(doc.annotations);
  if (entries.length === 0) return wrap;

  const label = document.createElement('div');
  label.className = 'toc-section-label';
  label.textContent = '내가 추가한 목차';
  wrap.appendChild(label);

  const list = document.createElement('div');
  list.className = 'toc-list';
  entries.forEach((entry, index) => {
    const row = document.createElement('div');
    row.className = 'toc-row';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toc-item';
    btn.textContent = `${entry.title} (${entry.page}쪽)`;
    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      goToPage(entry.page);
      closeTocPopup();
    });
    row.appendChild(btn);

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'toc-remove-btn';
    removeBtn.setAttribute('aria-label', '목차 항목 삭제');
    removeBtn.title = '삭제';
    removeBtn.textContent = '✕';
    removeBtn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const d = activeDoc();
      if (!d) return;
      pushUndoSnapshot(d);
      store.removeCustomTocEntry(d.annotations, index);
      persist();
      openTocPopup();
    });
    row.appendChild(removeBtn);

    list.appendChild(row);
  });
  wrap.appendChild(list);
  return wrap;
}

function buildTocAddRow() {
  const wrap = document.createElement('div');
  wrap.className = 'toc-add-row';

  const doc = activeDoc();
  if (!doc) return wrap;

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'toc-add-input';
  input.placeholder = `현재 페이지(${doc.currentPage}쪽) 제목 입력`;
  input.setAttribute('aria-label', '새 목차 제목');

  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'toc-add-btn';
  addBtn.textContent = '+ 목차 추가';

  const submit = () => {
    const d = activeDoc();
    if (!d) return;
    const title = input.value.trim() || `${d.currentPage}쪽`;
    pushUndoSnapshot(d);
    store.addCustomTocEntry(d.annotations, title, d.currentPage);
    persist();
    openTocPopup();
  };

  addBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); submit(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); submit(); }
  });

  wrap.appendChild(input);
  wrap.appendChild(addBtn);
  return wrap;
}

function closeTocPopup() {
  els.tocPopup.hidden = true;
  els.tocPopup.innerHTML = '';
  hideModalBackdropIfNoneOpen();
}

function showModalBackdrop() {
  els.modalBackdrop.hidden = false;
}

function hideModalBackdropIfNoneOpen() {
  if (els.tocPopup.hidden && els.favoritePopup.hidden && els.toolPopup.hidden && els.feedbackPopup.hidden) {
    els.modalBackdrop.hidden = true;
  }
}

async function buildTocItems(items, container, depth) {
  for (const item of items) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toc-item';
    btn.style.paddingLeft = `${12 + depth * 18}px`;

    const pageNum = await resolveOutlineDestPage(item.dest);
    btn.textContent = pageNum ? `${item.title} (${pageNum}쪽)` : item.title;
    if (pageNum) {
      btn.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        goToPage(pageNum);
        closeTocPopup();
      });
    } else {
      btn.disabled = true;
    }
    container.appendChild(btn);

    if (item.items && item.items.length) {
      await buildTocItems(item.items, container, depth + 1);
    }
  }
}

async function resolveOutlineDestPage(dest) {
  const doc = activeDoc();
  if (!doc) return null;
  try {
    let explicitDest = dest;
    if (typeof dest === 'string') {
      explicitDest = await doc.pdfDoc.getDestination(dest);
    }
    if (!explicitDest || !explicitDest[0]) return null;
    const index = await doc.pdfDoc.getPageIndex(explicitDest[0]);
    return index + 1;
  } catch {
    return null;
  }
}

// ---------------- page favorites (floating popup) ----------------

function onFavoriteButtonClick() {
  if (!activeDoc()) return;
  if (!els.favoritePopup.hidden) {
    closeFavoritePopup();
  } else {
    finishActiveTextEditor();
    closePopup();
    closeTocPopup();
    closeFeedbackPopup();
    openFavoritePopup();
  }
}

function openFavoritePopup() {
  const doc = activeDoc();
  if (!doc) return;
  const popup = els.favoritePopup;
  popup.innerHTML = '';
  popup.appendChild(buildPopupCloseButton(closeFavoritePopup));

  const left = document.createElement('div');
  left.className = 'popup-col-left';

  const toggleBtn = document.createElement('button');
  toggleBtn.type = 'button';
  toggleBtn.className = 'favorite-toggle-btn';
  const isFav = store.isFavorite(doc.annotations, doc.currentPage);
  toggleBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="' + (isFav ? 'currentColor' : 'none') + '" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
    + '<polygon points="12,3 14.7,9.3 21.5,9.9 16.3,14.4 17.9,21 12,17.3 6.1,21 7.7,14.4 2.5,9.9 9.3,9.3"/></svg>'
    + '<span>' + (isFav ? `${doc.currentPage}쪽 즐겨찾기 해제` : `${doc.currentPage}쪽 즐겨찾기 추가`) + '</span>';
  toggleBtn.style.color = isFav ? 'var(--favorite)' : 'var(--text)';
  toggleBtn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const d = activeDoc();
    if (!d) return;
    pushUndoSnapshot(d);
    store.toggleFavorite(d.annotations, d.currentPage);
    updateFavoriteUI();
    persist();
    openFavoritePopup();
  });
  left.appendChild(toggleBtn);
  popup.appendChild(left);

  const right = document.createElement('div');
  right.className = 'popup-col-right';

  const favorites = store.getFavorites(doc.annotations);
  if (favorites.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'popup-label';
    empty.textContent = '즐겨찾기한 페이지가 없습니다.';
    right.appendChild(empty);
  } else {
    const label = document.createElement('div');
    label.className = 'toc-section-label';
    label.style.margin = '0 0 8px';
    label.textContent = '즐겨찾기한 페이지';
    right.appendChild(label);

    const list = document.createElement('div');
    list.className = 'toc-list';
    favorites.forEach((pageNum) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'toc-item';
      btn.textContent = `${pageNum}쪽`;
      btn.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        goToPage(pageNum);
        closeFavoritePopup();
      });
      list.appendChild(btn);
    });
    right.appendChild(list);
  }
  popup.appendChild(right);

  popup.hidden = false;
  showModalBackdrop();
}

function closeFavoritePopup() {
  els.favoritePopup.hidden = true;
  els.favoritePopup.innerHTML = '';
  hideModalBackdropIfNoneOpen();
}

// ---------------- feedback (floating popup) ----------------

function onFeedbackButtonClick() {
  if (!els.feedbackPopup.hidden) {
    closeFeedbackPopup();
  } else {
    finishActiveTextEditor();
    closePopup();
    closeTocPopup();
    closeFavoritePopup();
    openFeedbackPopup();
  }
}

function openFeedbackPopup() {
  const popup = els.feedbackPopup;
  popup.innerHTML = '';
  popup.appendChild(buildPopupCloseButton(closeFeedbackPopup));

  const title = document.createElement('h2');
  title.className = 'feedback-title';
  title.textContent = '불편한 점 알리기';
  popup.appendChild(title);

  const textarea = document.createElement('textarea');
  textarea.className = 'feedback-textarea';
  textarea.setAttribute('aria-label', '불편한 점 입력');
  textarea.placeholder = '어떤 점이 불편했는지 자유롭게 적어주세요.';
  popup.appendChild(textarea);

  const status = document.createElement('div');
  status.className = 'feedback-status';
  popup.appendChild(status);

  const btnRow = document.createElement('div');
  btnRow.className = 'feedback-btn-row';

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'feedback-cancel-btn';
  cancelBtn.textContent = '취소';
  cancelBtn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    closeFeedbackPopup();
  });
  btnRow.appendChild(cancelBtn);

  const submitBtn = document.createElement('button');
  submitBtn.type = 'button';
  submitBtn.className = 'feedback-submit-btn';
  submitBtn.textContent = '알리기';
  submitBtn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    submitFeedback(textarea, submitBtn, status);
  });
  btnRow.appendChild(submitBtn);

  popup.appendChild(btnRow);

  popup.hidden = false;
  showModalBackdrop();
  textarea.focus();
}

function closeFeedbackPopup() {
  els.feedbackPopup.hidden = true;
  els.feedbackPopup.innerHTML = '';
  hideModalBackdropIfNoneOpen();
}

async function submitFeedback(textarea, submitBtn, status) {
  const message = textarea.value.trim();
  if (!message) {
    status.textContent = '내용을 입력해주세요.';
    status.classList.add('feedback-status-error');
    return;
  }
  if (!FEEDBACK_FORM_ENDPOINT) {
    status.textContent = '피드백 전송이 아직 설정되지 않았습니다. 개발자에게 알려주세요.';
    status.classList.add('feedback-status-error');
    return;
  }

  submitBtn.disabled = true;
  status.classList.remove('feedback-status-error');
  status.textContent = '보내는 중…';

  try {
    const embed = {
      title: '저시력 학생 필기 프로그램(웹) - 불편한 점 알리기',
      description: message.slice(0, 4096),
      timestamp: new Date().toISOString(),
    };
    const res = await fetch(FEEDBACK_FORM_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ embeds: [embed] }),
    });
    if (!res.ok) throw new Error(String(res.status));
    closeFeedbackPopup();
  } catch {
    submitBtn.disabled = false;
    status.textContent = '전송에 실패했습니다. 인터넷 연결을 확인하고 다시 시도해주세요.';
    status.classList.add('feedback-status-error');
  }
}

// ---------------- page navigation ----------------

function wirePageNav() {
  els.prevPageBtn.addEventListener('pointerdown', () => {
    const doc = activeDoc();
    if (doc) goToPage(doc.currentPage - 1);
  });
  els.nextPageBtn.addEventListener('pointerdown', () => {
    const doc = activeDoc();
    if (doc) goToPage(doc.currentPage + 1);
  });

  pageEdit = wireEditableField(els.pageIndicator, {
    getEditValue: () => {
      const doc = activeDoc();
      return doc ? String(doc.currentPage) : '';
    },
    formatDisplay: () => {
      const doc = activeDoc();
      return doc ? `${doc.currentPage} / ${doc.numPages}` : '- / -';
    },
    commit: (raw) => {
      if (!activeDoc()) return;
      const n = parseInt(String(raw).replace(/[^0-9]/g, ''), 10);
      if (!Number.isFinite(n)) return;
      goToPage(n);
    },
  });
}

function goToPage(n) {
  const doc = activeDoc();
  if (!doc) return;
  const target = Math.min(Math.max(1, n), doc.numPages);
  if (target === doc.currentPage) return;
  doc.currentPage = target;
  renderCurrentPage();
}

function updatePageIndicator() {
  pageEdit.refresh();
}

function wireKeyboard() {
  window.addEventListener('keydown', (e) => {
    const isEditableFocus = document.activeElement
      && (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA');

    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z') {
      if (isEditableFocus) return;
      undo();
      e.preventDefault();
      return;
    }

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'o') {
      handleOpenClick();
      e.preventDefault();
      return;
    }

    if (!activeDoc() || isEditableFocus) return;

    if ((e.key === 'Delete' || e.key === 'Backspace') && state.currentTool === 'select' && selection.length) {
      deleteSelection();
      e.preventDefault();
      return;
    }

    if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
      goToPage(activeDoc().currentPage - 1);
      e.preventDefault();
    } else if (e.key === 'ArrowRight' || e.key === 'PageDown') {
      goToPage(activeDoc().currentPage + 1);
      e.preventDefault();
    }
  });
}

// ---------------- 사용 기록 전송 (데스크톱 앱 main.js와 동일한 목적) ----------------
// 학생이 언제 접속/종료했는지 보호자가 확인할 수 있도록 디스코드 웹훅으로 자동 전송한다.
// (Formspree 무료 플랜 월 한도에 걸려 디스코드 웹훅으로 교체함, 2026-09-10)
// 데스크톱 버전은 os.hostname()으로 기기를 구분하지만 브라우저에는 그런 API가 없어 대신
// navigator.userAgent를 쓴다. localhost 개발 테스트 중에는 전송하지 않는다.

let usageSessionActive = false;

function isLocalDevHost() {
  return window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
}

function formatKoreanTimestamp(date) {
  return date.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', hour12: false });
}

function logUsageEvent(eventName) {
  if (!USAGE_LOG_ENDPOINT || isLocalDevHost()) return;
  const doc = activeDoc();
  const content = [
    `**저시력 학생 필기 프로그램(웹) - ${eventName}**`,
    `시각: ${formatKoreanTimestamp(new Date())}`,
    `기기: ${navigator.userAgent}`,
    `파일: ${doc ? doc.fileName : '(열린 파일 없음)'}`,
  ].join('\n');
  const body = JSON.stringify({ content });
  try {
    // 탭이 닫히는 중에는 일반 fetch가 취소될 수 있어 sendBeacon으로 보낸다.
    if (eventName === '앱 종료' && navigator.sendBeacon) {
      navigator.sendBeacon(USAGE_LOG_ENDPOINT, new Blob([body], { type: 'application/json' }));
    } else {
      fetch(USAGE_LOG_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body,
        keepalive: true,
      }).catch(() => {});
    }
  } catch (err) {
    console.warn('[사용 기록 전송 실패]', err);
  }
}

window.addEventListener('pagehide', () => {
  if (usageSessionActive) logUsageEvent('앱 종료');
});

// ---------------- sign-in gate ----------------

function showSignIn(message) {
  els.app.hidden = true;
  els.signinScreen.hidden = false;
  els.signinStatus.textContent = message || '';
}

function showApp() {
  els.signinScreen.hidden = true;
  els.app.hidden = false;
}

async function handleSignInClick() {
  els.signinStatus.textContent = '';
  els.signinBtn.disabled = true;
  try {
    await auth.signIn();
    showApp();
    await init();
    usageSessionActive = true;
    logUsageEvent('앱 접속');
  } catch (err) {
    if (err instanceof auth.WrongAccountError) {
      showSignIn(`이 계정(${err.email})은 사용할 수 없어요. 허용된 계정으로 다시 로그인해 주세요.`);
    } else {
      console.error('로그인 실패', err);
      showSignIn('로그인에 실패했어요. 잠시 후 다시 시도해 주세요.');
    }
  } finally {
    els.signinBtn.disabled = false;
  }
}

els.signinBtn.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  handleSignInClick();
});

async function boot() {
  showSignIn('로그인 확인 중...');
  const email = await auth.tryResume();
  if (email) {
    showApp();
    await init();
    usageSessionActive = true;
    logUsageEvent('앱 접속');
  } else {
    showSignIn();
  }
}

boot();
