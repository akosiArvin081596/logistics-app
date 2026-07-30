<template>
  <div
    ref="viewportRef"
    class="pz-viewport"
    @wheel.prevent="onWheel"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerUp"
    @dblclick="onDoubleClick"
  >
    <!-- Transformed page stack. All pages render into this wrapper; the
         translate/scale transform (top-left origin) is what zooms + pans. -->
    <div
      ref="contentRef"
      class="pz-content"
      :class="{ 'pz-grabbable': !failed, 'pz-dragging': isInteracting }"
      :style="transformStyle"
    >
      <component
        :is="pdfComp"
        v-if="pdfComp && src && !failed"
        :source="src"
        :scale="RENDER_SCALE"
        @rendered="onRendered"
        @loading-failed="onFail"
        @rendering-failed="onFail"
      />
    </div>

    <!-- Loading: lazy chunk import + first render pending. -->
    <div v-if="loading && !failed" class="pz-status" aria-live="polite">
      <div class="pz-spinner" role="status" aria-label="Loading invoice PDF"></div>
      <div class="pz-status-text">Loading invoice…</div>
    </div>

    <!-- Failure fallback: the invoice is always reachable via a direct link. -->
    <div v-if="failed" class="pz-status pz-status-fail">
      <div class="pz-status-text">Couldn't render the PDF preview.</div>
      <a :href="src" target="_blank" rel="noopener" class="pz-open-link">Open PDF &#8599;</a>
    </div>

    <!-- Bottom-center zoom controls (ported from ZoomableImage). -->
    <div v-if="!failed" class="pz-controls">
      <button type="button" class="pz-btn" aria-label="Zoom out" @click="zoomBy(-ZOOM_STEP)">&minus;</button>
      <button type="button" class="pz-btn pz-reset" aria-label="Reset zoom" @click="reset">Reset</button>
      <button type="button" class="pz-btn" aria-label="Zoom in" @click="zoomBy(ZOOM_STEP)">+</button>
    </div>
  </div>
</template>

<script setup>
import { ref, shallowRef, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'

// Self-contained scroll-zoom PDF viewer. Renders every page of a PDF stacked
// into a CSS-transformed wrapper so the user can wheel-zoom, drag-pan, pinch and
// double-click exactly like the Expenses receipt viewer (ZoomableImage.vue) —
// the zoom mechanics are ported from it. Two deliberate differences for a tall
// multi-page invoice: vertical drag works at ALL scales (drag down through the
// pages) with top-pinned pan bounds, and the view re-clamps on the async
// @rendered event because the canvases don't have a size until pdf.js paints.
//
// vue-pdf-embed (the pdf.js Vue wrapper) is lazy-imported so the ~pdf.js chunk
// only downloads when an invoice modal actually opens — mirrors the heic2any
// dynamic import() in lib/imageUtils.js.
const props = defineProps({
  // PDF URL, e.g. /api/invoices/317/pdf. Same-origin, so the session cookie
  // rides along automatically — no auth wiring needed here.
  src: { type: String, default: '' },
})

// Target a consistent ~2x effective backing resolution so text stays crisp when
// zoomed. vue-pdf-embed already renders at paneWidth × devicePixelRatio, so we
// DIVIDE by DPR here — otherwise a retina (DPR 2) display renders at 4x per side
// (~16x area, ~100MB/page) and a multi-page invoice can blank-render past iOS
// Safari's canvas-area cap. Floor at 1x. Interactive zoom is a pure CSS transform.
const RENDER_SCALE = Math.max(1, 2 / (window.devicePixelRatio || 1))
const FIT_SCALE = 1          // fit-to-width — the default / reset zoom
const MIN_SCALE = 0.2        // zoom-out floor: shrink below fit-width to see a whole multi-page doc at once
const MAX_SCALE = 5
const ZOOM_STEP = 0.5        // +/- button increment
const WHEEL_FACTOR = 0.0015  // wheel delta -> scale delta
const DBL_SCALE = 2          // double-click "zoom to" target

const viewportRef = ref(null)
const contentRef = ref(null)
// shallowRef: this holds a component definition, which must not be made deeply
// reactive (Vue warns otherwise and it's pointless work).
const pdfComp = shallowRef(null)

const loading = ref(true)  // true until the first @rendered (or a failure)
const failed = ref(false)

// scale/tx/ty drive the transform; ported from ZoomableImage.
const scale = ref(1)
const tx = ref(0)
const ty = ref(0)
// Drop the CSS transition while dragging/pinching so it tracks the pointer 1:1.
const isInteracting = ref(false)

// Active pointers keyed by pointerId (unified mouse + touch): 1 => pan, 2 => pinch.
const pointers = new Map()
let dragStart = null   // { x, y, tx, ty }
let pinchStart = null  // { dist, scale }
let ro = null          // ResizeObserver — re-clamp on pane resize / expand toggle

// transform-origin is top-left (see <style>), which pairs cleanly with the
// top-pinned pan bounds below and makes the anchor math a simple linear solve.
const transformStyle = computed(() => ({
  transform: `translate(${tx.value}px, ${ty.value}px) scale(${scale.value})`,
}))

function clampScale(v) {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, v))
}

// Pan bounds, each axis independent. When the content is SMALLER than the pane on
// that axis (e.g. zoomed out far enough to see the whole document), it's centered;
// otherwise it's clamped within the overflow — vertical is top-pinned, so ty=0 is
// the top of page 1. The two branches meet continuously at the fit point (both give
// 0 there), so wheeling across it is seamless. scrollWidth/scrollHeight are the
// un-transformed layout sizes, so multiply by the current scale.
function clampPan() {
  const vp = viewportRef.value
  const content = contentRef.value
  if (!vp || !content) return
  const viewportW = vp.clientWidth
  const viewportH = vp.clientHeight
  const contentH = content.scrollHeight * scale.value
  const contentW = content.scrollWidth * scale.value

  if (contentH <= viewportH) {
    ty.value = (viewportH - contentH) / 2                             // whole doc fits — center vertically
  } else {
    ty.value = Math.min(0, Math.max(viewportH - contentH, ty.value))  // taller than pane — top-pinned pan
  }

  if (contentW <= viewportW) {
    tx.value = (viewportW - contentW) / 2                             // at/under fit-to-width — center horizontally
  } else {
    tx.value = Math.min(0, Math.max(viewportW - contentW, tx.value))  // wider than pane — clamp within overflow
  }
}

// Zoom to `target`, keeping the point under (anchorX, anchorY) fixed on screen.
// With transform-origin at the top-left, a layout point (lx, ly) maps to screen
// as (vpLeft + tx + lx*scale, vpTop + ty + ly*scale); solve tx/ty for the new
// scale so the anchored layout point stays put. Buttons pass the pane center.
function applyZoom(target, anchorX, anchorY) {
  const next = clampScale(target)
  if (next === scale.value) return
  const vp = viewportRef.value
  if (vp && anchorX != null) {
    const rect = vp.getBoundingClientRect()
    const lx = (anchorX - rect.left - tx.value) / scale.value
    const ly = (anchorY - rect.top - ty.value) / scale.value
    tx.value = anchorX - rect.left - lx * next
    ty.value = anchorY - rect.top - ly * next
  }
  scale.value = next
  clampPan()
}

// +/- buttons zoom toward the pane center so the content doesn't drift.
function zoomBy(delta) {
  const vp = viewportRef.value
  if (vp) {
    const r = vp.getBoundingClientRect()
    applyZoom(scale.value + delta, r.left + r.width / 2, r.top + r.height / 2)
  } else {
    applyZoom(scale.value + delta)
  }
}

// Reset goes to the top of page 1 at fit-to-width. ty=0 is the top here (unlike
// ZoomableImage, we never force ty=0 mid-zoom — only an explicit reset/rerender
// snaps back to the top).
function reset() {
  scale.value = FIT_SCALE
  tx.value = 0
  ty.value = 0
}

function onWheel(e) {
  applyZoom(scale.value - e.deltaY * WHEEL_FACTOR, e.clientX, e.clientY)
}

function onDoubleClick(e) {
  if (scale.value > FIT_SCALE) applyZoom(FIT_SCALE, e.clientX, e.clientY)
  else applyZoom(DBL_SCALE, e.clientX, e.clientY)
}

function pointerDistance() {
  const [a, b] = [...pointers.values()]
  return Math.hypot(a.x - b.x, a.y - b.y)
}
function pointerMidpoint() {
  const [a, b] = [...pointers.values()]
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
}

function onPointerDown(e) {
  if (failed.value) return
  viewportRef.value?.setPointerCapture?.(e.pointerId)
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
  if (pointers.size === 2) {
    pinchStart = { dist: pointerDistance(), scale: scale.value }
    dragStart = null
    isInteracting.value = true
  } else if (pointers.size === 1) {
    // No scale>1 guard (ZoomableImage has one): dragging at scale 1 is how the
    // user moves down through pages 2-3 of a tall invoice.
    dragStart = { x: e.clientX, y: e.clientY, tx: tx.value, ty: ty.value }
    isInteracting.value = true
  }
}

function onPointerMove(e) {
  if (!pointers.has(e.pointerId)) return
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
  if (pointers.size === 2 && pinchStart) {
    const mid = pointerMidpoint()
    applyZoom(pinchStart.scale * (pointerDistance() / pinchStart.dist), mid.x, mid.y)
  } else if (pointers.size === 1 && dragStart) {
    tx.value = dragStart.tx + (e.clientX - dragStart.x)
    ty.value = dragStart.ty + (e.clientY - dragStart.y)
    clampPan()
  }
}

function onPointerUp(e) {
  pointers.delete(e.pointerId)
  viewportRef.value?.releasePointerCapture?.(e.pointerId)
  if (pointers.size < 2) pinchStart = null
  if (pointers.size === 1) {
    // One finger remains after a pinch — re-anchor so the drag doesn't jump.
    const [p] = [...pointers.values()]
    dragStart = { x: p.x, y: p.y, tx: tx.value, ty: ty.value }
  } else if (pointers.size === 0) {
    dragStart = null
    isInteracting.value = false
  }
}

// Pages render asynchronously, so contentRef has no height until this fires:
// reset to the top at fit-width and (re)compute the pan bounds now that the
// canvases exist.
function onRendered() {
  failed.value = false
  loading.value = false
  reset()
  nextTick(clampPan)
}

function onFail() {
  failed.value = true
  loading.value = false
}

async function loadPdfComp() {
  try {
    const mod = await import('vue-pdf-embed')
    pdfComp.value = mod.default
  } catch {
    // Chunk failed to load (offline / network) — surface the direct-link fallback.
    onFail()
  }
}

// New invoice selected -> back to the loading state and the top of the doc; the
// component re-fetches when :source changes and fires @rendered again.
watch(() => props.src, () => {
  loading.value = true
  failed.value = false
  reset()
})

onMounted(() => {
  loadPdfComp()
  if (viewportRef.value && 'ResizeObserver' in window) {
    // Pane resize (window or the "Expand PDF" toggle) changes fit-width height,
    // so the pan bounds must be recomputed.
    ro = new ResizeObserver(() => clampPan())
    ro.observe(viewportRef.value)
  }
})

onBeforeUnmount(() => {
  ro?.disconnect()
  ro = null
})
</script>

<style scoped>
.pz-viewport {
  position: absolute;
  inset: 0;
  overflow: hidden;
  touch-action: none;
  user-select: none;
  background: #f1f5f9;
}

.pz-content {
  width: 100%;
  transform-origin: top left;
  transition: transform 0.15s ease;
  will-change: transform;
}
.pz-content.pz-dragging { transition: none; }
.pz-content.pz-grabbable { cursor: grab; }
.pz-content.pz-grabbable.pz-dragging { cursor: grabbing; }

/* Fit every page canvas to the pane width; the 2x backing store is downscaled
   by the browser, so it stays crisp. height:auto keeps the page aspect ratio. */
.pz-content :deep(.vue-pdf-embed),
.pz-content :deep(.vue-pdf-embed__page) {
  width: 100%;
}
.pz-content :deep(.vue-pdf-embed__page) {
  margin: 0 0 8px;
}
.pz-content :deep(.vue-pdf-embed__page canvas),
.pz-content :deep(canvas) {
  display: block;
  width: 100% !important;
  height: auto !important;
}

/* Loading / failure overlays — siblings of the transformed content so they
   don't move or scale with zoom. */
.pz-status {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.75rem;
  pointer-events: none;
  color: #64748b;
}
.pz-status-fail { pointer-events: auto; }
.pz-status-text { font-size: 0.85rem; font-weight: 500; }
.pz-spinner {
  width: 34px;
  height: 34px;
  border: 3px solid #cbd5e1;
  border-top-color: #3b82f6;
  border-radius: 50%;
  animation: pz-spin 0.8s linear infinite;
}
@keyframes pz-spin { to { transform: rotate(360deg); } }
.pz-open-link {
  padding: 0.45rem 0.9rem;
  border-radius: 8px;
  background: #2563eb;
  color: #fff;
  font-size: 0.8rem;
  font-weight: 600;
  text-decoration: none;
}
.pz-open-link:hover { background: #1d4ed8; }

/* Bottom-center pill controls — ported from ZoomableImage's .zoom-controls. */
.pz-controls {
  position: absolute;
  bottom: 0.75rem;
  left: 50%;
  transform: translateX(-50%);
  z-index: 3;
  display: flex;
  gap: 0.5rem;
  padding: 0.4rem;
  border-radius: 999px;
  background: rgba(15, 23, 42, 0.62);
  backdrop-filter: blur(4px);
}
.pz-btn {
  min-width: 2.25rem;
  height: 2.25rem;
  padding: 0 0.75rem;
  border: none;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.14);
  color: #fff;
  font-size: 1.1rem;
  font-weight: 700;
  line-height: 1;
  cursor: pointer;
  font-family: inherit;
  transition: background 0.15s;
}
.pz-btn:hover { background: rgba(255, 255, 255, 0.3); }
.pz-reset { font-size: 0.8rem; font-weight: 600; }
</style>
