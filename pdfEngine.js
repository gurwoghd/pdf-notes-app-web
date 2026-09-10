import * as pdfjsLib from './vendor/pdfjs-dist/pdf.mjs';

const workerUrl = new URL('./vendor/pdfjs-dist/pdf.worker.mjs', import.meta.url);
pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl.href;

export async function loadDocument(data) {
  const task = pdfjsLib.getDocument({ data });
  return task.promise;
}

export async function getPage(pdfDoc, pageNumber) {
  return pdfDoc.getPage(pageNumber);
}

/**
 * Computes a pdf.js viewport whose backing-pixel resolution accounts for the
 * device pixel ratio, so rendering stays crisp at high zoom on HiDPI screens.
 */
export function computeRenderViewport(page, scale) {
  const dpr = window.devicePixelRatio || 1;
  const viewport = page.getViewport({ scale: scale * dpr });
  return {
    viewport,
    dpr,
    cssWidth: viewport.width / dpr,
    cssHeight: viewport.height / dpr,
  };
}

export async function renderPageToCanvas(page, canvas, viewport) {
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  const ctx = canvas.getContext('2d');
  await page.render({ canvasContext: ctx, viewport }).promise;
}

export function sizeOverlayCanvas(canvas, viewport) {
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
}

/** Converts a pointer event's client coordinates to PDF page-space (scale 1) coordinates. */
export function eventToPdfPoint(evt, canvasEl, viewport) {
  const rect = canvasEl.getBoundingClientRect();
  const cssX = evt.clientX - rect.left;
  const cssY = evt.clientY - rect.top;
  const scaleX = canvasEl.width / rect.width;
  const scaleY = canvasEl.height / rect.height;
  const [x, y] = viewport.convertToPdfPoint(cssX * scaleX, cssY * scaleY);
  return { x, y };
}

/** Converts a PDF page-space point to backing-pixel canvas coordinates for the given viewport. */
export function pdfPointToCanvas(viewport, x, y) {
  const [cx, cy] = viewport.convertToViewportPoint(x, y);
  return { x: cx, y: cy };
}

export function pdfWidthToCanvas(viewport, width) {
  return width * viewport.scale;
}
