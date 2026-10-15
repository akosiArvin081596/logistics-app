// The load-detail rate con tile (RateConPdfSection.vue + RateConViewer.vue):
// its wording, its request and the viewer's zoom maths, kept pure so
// scripts/test-load-detail-ratecon.mjs can pin them.
//
// The server decides who may see a rate con (GET /api/loads/:loadId/ratecon.pdf
// is Super Admin only); the tile only chooses what to say about each answer.

export const RATECON_NOT_ON_FILE = 'No rate con on file'
export const RATECON_UNAVAILABLE = "Rate con can't be loaded right now"

export function rateConPdfUrl(loadId) {
  return `/api/loads/${encodeURIComponent(String(loadId == null ? '' : loadId).trim())}/ratecon.pdf`
}

// 404: nothing on file. 503: Drive (or the archive) can't be asked right now.
// 413 / 422 carry the server's own plain sentence (too large, not a PDF).
// Anything else, a dropped connection included, reads as "can't be loaded".
export function rateConFailureText(status, serverMessage) {
  if (status === 404) return RATECON_NOT_ON_FILE
  if (status === 503) return RATECON_UNAVAILABLE
  if ((status === 413 || status === 422) && serverMessage) return String(serverMessage)
  return RATECON_UNAVAILABLE
}

// ── Viewer zoom ──────────────────────────────────────────────────────────────
// Zoom 1 is "fit to page": the whole page inside the tile, and the least the
// viewer zooms to. The drawn width is the fit width times the zoom, up to 400 %.
// Where the page sits at a zoom, and how input moves it: rateConZoom.js.
export const FIT_ZOOM = 1
export const MIN_ZOOM = FIT_ZOOM
export const MAX_ZOOM = 4
export const ZOOM_STEP = 1.25
// A US Letter page, until the document says otherwise.
export const DEFAULT_PAGE_ASPECT = 11 / 8.5

// Widest page (CSS px) that fits a stage of stageW × stageH at once.
export function fitPageWidth(stageW, stageH, aspect = DEFAULT_PAGE_ASPECT) {
  const w = Number(stageW)
  const h = Number(stageH)
  const a = Number(aspect) > 0 ? Number(aspect) : DEFAULT_PAGE_ASPECT
  if (!(w > 0)) return 0
  if (!(h > 0)) return Math.floor(w)
  return Math.max(1, Math.floor(Math.min(w, h / a)))
}

export function clampZoom(z, maxZoom = MAX_ZOOM) {
  const n = Number(z)
  const hi = Math.max(FIT_ZOOM, Math.min(MAX_ZOOM, Number(maxZoom) || MAX_ZOOM))
  if (!Number.isFinite(n)) return FIT_ZOOM
  return Math.min(hi, Math.max(MIN_ZOOM, n))
}

export function stepZoom(z, direction, maxZoom = MAX_ZOOM) {
  const next = direction > 0 ? z * ZOOM_STEP : z / ZOOM_STEP
  // Land exactly on fit when a step crosses it, so "fit" is reachable by +/-.
  if ((z < FIT_ZOOM && next > FIT_ZOOM) || (z > FIT_ZOOM && next < FIT_ZOOM)) return FIT_ZOOM
  return clampZoom(next, maxZoom)
}

// The tallest the tile may stand inside the scroll area holding it (the
// dialog body): its visible height less its padding and a small margin, so the
// controls and the fitted page show without scrolling. Never under 240 px, the
// least a page is readable at; 0 (no ceiling) when there is nothing to measure.
export function tileMaxHeight(clientHeight, padTop = 0, padBottom = 0) {
  const h = Number(clientHeight)
  if (!(h > 0)) return 0
  const usable = h - (Number(padTop) || 0) - (Number(padBottom) || 0) - 8
  return Math.max(240, Math.floor(usable))
}

export function clampPage(p, numPages) {
  const n = Math.max(1, Number(numPages) || 1)
  const v = Math.round(Number(p))
  if (!Number.isFinite(v)) return 1
  return Math.min(n, Math.max(1, v))
}
