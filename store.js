export function emptyAnnotations() {
  return { version: 1, pages: {}, favorites: [], customToc: [] };
}

export function normalizeAnnotations(annotations) {
  if (!Array.isArray(annotations.favorites)) annotations.favorites = [];
  if (!Array.isArray(annotations.customToc)) annotations.customToc = [];
  return annotations;
}

export function ensurePage(annotations, pageNumber) {
  const key = String(pageNumber);
  if (!annotations.pages[key]) {
    annotations.pages[key] = { scale: null, pen: [], highlighter: [], text: [] };
  }
  if (!annotations.pages[key].text) {
    annotations.pages[key].text = [];
  }
  return annotations.pages[key];
}

export function getPageScale(annotations, pageNumber) {
  const key = String(pageNumber);
  const page = annotations.pages[key];
  return page && typeof page.scale === 'number' ? page.scale : null;
}

export function setPageScale(annotations, pageNumber, scale) {
  const page = ensurePage(annotations, pageNumber);
  page.scale = scale;
}

export function addStroke(annotations, pageNumber, layer, stroke) {
  const page = ensurePage(annotations, pageNumber);
  page[layer].push(stroke);
}

export function removeStrokes(annotations, pageNumber, layer, indices) {
  const page = ensurePage(annotations, pageNumber);
  const indexSet = new Set(indices);
  page[layer] = page[layer].filter((_, i) => !indexSet.has(i));
}

export function getStrokes(annotations, pageNumber, layer) {
  const key = String(pageNumber);
  const page = annotations.pages[key];
  return page ? page[layer] : [];
}

// ---------------- text annotations ----------------

export function addText(annotations, pageNumber, textEntry) {
  const page = ensurePage(annotations, pageNumber);
  page.text.push(textEntry);
}

export function removeTexts(annotations, pageNumber, indices) {
  const page = ensurePage(annotations, pageNumber);
  const indexSet = new Set(indices);
  page.text = page.text.filter((_, i) => !indexSet.has(i));
}

export function getTexts(annotations, pageNumber) {
  const key = String(pageNumber);
  const page = annotations.pages[key];
  return page && page.text ? page.text : [];
}

// ---------------- page favorites ----------------

export function isFavorite(annotations, pageNumber) {
  return annotations.favorites.includes(pageNumber);
}

export function toggleFavorite(annotations, pageNumber) {
  const idx = annotations.favorites.indexOf(pageNumber);
  if (idx === -1) {
    annotations.favorites.push(pageNumber);
    annotations.favorites.sort((a, b) => a - b);
  } else {
    annotations.favorites.splice(idx, 1);
  }
}

export function getFavorites(annotations) {
  return annotations.favorites;
}

// ---------------- student-added table of contents ----------------

export function addCustomTocEntry(annotations, title, pageNumber) {
  annotations.customToc.push({ title, page: pageNumber });
  annotations.customToc.sort((a, b) => a.page - b.page);
}

export function removeCustomTocEntry(annotations, index) {
  annotations.customToc.splice(index, 1);
}

export function getCustomToc(annotations) {
  return annotations.customToc;
}
