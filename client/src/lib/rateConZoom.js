// Where the rate con page sits inside the viewer (RateConViewer.vue), and how
// the wheel, a drag, a pinch and the zoom buttons move it. Pure, no DOM:
// scripts/test-ratecon-viewer-zoom.mjs pins it.
//
// Coordinates are CSS px inside the stage (the viewer's PDF area), from its
// top-left corner. A stage is { w, h, gap }: its size, and the margin kept
// round a page that fits. A view is { zoom, x, y }: the page drawn at `zoom`
// times its fit size, its top-left corner at (x, y).
//
// The rules:
// - Zooming in keeps the PDF point under the pointer exactly where it is
//   (a pointer in the margin zooms about the nearest point of the page).
// - Zooming out keeps it too while the page still covers the stage; gaps it
//   opens close gradually, and the last step lands on the centred fit view,
//   the same view the Fit button shows.
// - Along an axis where the page fits, it rests centred; along one where it is
//   longer than the stage, its edges never come inside the gap. A drag can
//   bring a page that a zoom left off those bounds back towards them, never
//   push it further out, so nothing ever snaps.
import { FIT_ZOOM, DEFAULT_PAGE_ASPECT, fitPageWidth, clampZoom } from './rateConView.js'

// iOS Safari refuses canvases past ~16.7 million pixels and paints them blank.
export const MAX_CANVAS_PIXELS = 16 * 1000 * 1000
// The wheel: about 1.2x per mouse-wheel notch (100 px). A trackpad pinch comes
// as wheel events with ctrlKey and small deltas, scaled finer and capped lower
// so ctrl + a mouse wheel is still a single step.
const WHEEL_PER_PX = 0.0018
const WHEEL_MAX_PX = 150
const PINCH_PER_PX = 0.01
const PINCH_MAX_PX = 25
const LINE_PX = 33   // deltaMode 1: lines (Firefox)
const PAGE_PX = 800  // deltaMode 2: pages
const DEFAULT_GAP = 8

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
const gapOf = (stage) => (Number(stage && stage.gap) >= 0 ? Number(stage.gap) : DEFAULT_GAP)

// The page's size at fit: the whole page inside the stage, less the gap.
export function fitSize(stage, aspect = DEFAULT_PAGE_ASPECT) {
  const a = Number(aspect) > 0 ? Number(aspect) : DEFAULT_PAGE_ASPECT
  const gap = gapOf(stage)
  const w = fitPageWidth(Number(stage.w) - 2 * gap, Number(stage.h) - 2 * gap, a)
  return { w, h: w * a }
}

// Centred, on whole pixels: the fit view is where every zoom starts, so what is
// on screen at fit and what the maths holds are the same point.
export function fitView(stage, fit) {
  return { zoom: FIT_ZOOM, x: Math.round((stage.w - fit.w) / 2), y: Math.round((stage.h - fit.h) / 2) }
}

// Where the page's near edge may sit along one axis: the centred position when
// the page fits (gap included), else anywhere that keeps both edges outside the gap.
export function axisRange(stageLen, pageLen, gap) {
  if (pageLen <= stageLen - 2 * gap) {
    const c = (stageLen - pageLen) / 2
    return [c, c]
  }
  return [stageLen - pageLen - gap, gap]
}

export function clampView(view, stage, fit) {
  if (!(view.zoom > FIT_ZOOM)) return fitView(stage, fit)
  const gap = gapOf(stage)
  const [xl, xh] = axisRange(stage.w, fit.w * view.zoom, gap)
  const [yl, yh] = axisRange(stage.h, fit.h * view.zoom, gap)
  return { zoom: view.zoom, x: clamp(view.x, xl, xh), y: clamp(view.y, yl, yh) }
}

// Zoom to `nextZoom` about the stage point (px, py).
export function zoomAt(view, nextZoom, px, py, stage, fit) {
  const z0 = view.zoom
  const z1 = clampZoom(nextZoom)
  if (z1 === z0) return view
  if (z1 <= FIT_ZOOM) return fitView(stage, fit)
  const ax = clamp(Number(px), view.x, view.x + fit.w * z0)
  const ay = clamp(Number(py), view.y, view.y + fit.h * z0)
  const k = z1 / z0
  let x = ax - (ax - view.x) * k
  let y = ay - (ay - view.y) * k
  if (k < 1) {
    // Share of what is off bounds that this step keeps: 0 on the step that
    // reaches fit, and the same over a zoom-out however it is split up.
    const keep = (z1 - FIT_ZOOM) / (z0 - FIT_ZOOM)
    const gap = gapOf(stage)
    x = settle(x, stage.w, fit.w * z1, gap, keep)
    y = settle(y, stage.h, fit.h * z1, gap, keep)
  }
  return { zoom: z1, x, y }
}
function settle(v, stageLen, pageLen, gap, keep) {
  const [lo, hi] = axisRange(stageLen, pageLen, gap)
  const target = clamp(v, lo, hi)
  return target + (v - target) * keep
}

// Move the page by (dx, dy). Nothing moves at fit.
export function panBy(view, dx, dy, stage, fit) {
  if (!(view.zoom > FIT_ZOOM)) return view
  const gap = gapOf(stage)
  return {
    zoom: view.zoom,
    x: towardRange(view.x + (Number(dx) || 0), view.x, stage.w, fit.w * view.zoom, gap),
    y: towardRange(view.y + (Number(dy) || 0), view.y, stage.h, fit.h * view.zoom, gap),
  }
}
// Within the bounds, or between them and where the page already is.
function towardRange(v, from, stageLen, pageLen, gap) {
  const [lo, hi] = axisRange(stageLen, pageLen, gap)
  return clamp(v, Math.min(lo, from), Math.max(hi, from))
}

// Two fingers moved from `from` to `to` ({ dist, x, y }: their spread and
// midpoint): zoom by the change in spread about the old midpoint, then follow
// the midpoint.
export function pinchStep(view, from, to, stage, fit) {
  const ratio = from.dist > 0 && to.dist > 0 ? to.dist / from.dist : 1
  const zoomed = zoomAt(view, view.zoom * ratio, from.x, from.y, stage, fit)
  return panBy(zoomed, to.x - from.x, to.y - from.y, stage, fit)
}

// The zoom factor for one wheel event: scaled by its delta, never fixed steps.
export function wheelZoomFactor(deltaY, deltaMode = 0, ctrlKey = false) {
  let px = Number(deltaY)
  if (!Number.isFinite(px) || px === 0) return 1
  if (deltaMode === 1) px *= LINE_PX
  else if (deltaMode === 2) px *= PAGE_PX
  if (ctrlKey) return Math.exp(-clamp(px, -PINCH_MAX_PX, PINCH_MAX_PX) * PINCH_PER_PX)
  return Math.exp(-clamp(px, -WHEEL_MAX_PX, WHEEL_MAX_PX) * WHEEL_PER_PX)
}

// Canvas pixels per CSS px for a page drawn cssW × cssH: the screen's density,
// lowered only as far as keeps the canvas under the iOS limit (400 % on a phone).
export function renderDensity(cssW, cssH, dpr = 1) {
  const d = Number(dpr) > 0 ? Number(dpr) : 1
  const area = Number(cssW) * Number(cssH)
  if (!(area > 0)) return d
  return Math.min(d, Math.sqrt(MAX_CANVAS_PIXELS / area))
}

// The stage changed size (full screen, a rotated phone): same zoom, and the
// page point at the stage's centre stays at its centre.
export function keepCentre(view, fromStage, fromFit, toStage, toFit) {
  if (!(view.zoom > FIT_ZOOM) || !(fromFit.w > 0) || !(toFit.w > 0)) return fitView(toStage, toFit)
  const u = (fromStage.w / 2 - view.x) / (fromFit.w * view.zoom)
  const v = (fromStage.h / 2 - view.y) / (fromFit.h * view.zoom)
  return clampView({
    zoom: view.zoom,
    x: toStage.w / 2 - u * toFit.w * view.zoom,
    y: toStage.h / 2 - v * toFit.h * view.zoom,
  }, toStage, toFit)
}

// A new page: the same zoom and column, at the top of the page.
export function pageTopView(zoom, x, stage, fit) {
  if (!(zoom > FIT_ZOOM)) return fitView(stage, fit)
  const [, top] = axisRange(stage.h, fit.h * zoom, gapOf(stage))
  return clampView({ zoom, x, y: top }, stage, fit)
}
