<!--
  A one-page-at-a-time PDF viewer for the load-detail rate con tile
  (RateConPdfSection.vue): the WHOLE page fits the tile by default, with zoom
  in / zoom out / fit to page, previous / next page ("Page X of Y") and full
  screen. On a phone: one finger scrolls a zoomed page, two fingers pinch-zoom.

  ⚠️ Why not PdfZoomViewer.vue: that viewer is shared by the invoice screens,
  payout statements and signing documents, stacks every page at fit-to-WIDTH,
  and pans by drag with the wheel zooming. The rate con tile wants a page that
  fits whole, page controls and native scrolling, and changing the shared
  viewer would change how those other screens look and behave. Both render
  with the same pdf.js through vue-pdf-embed's ESSENTIAL entry (see the long
  note in PdfZoomViewer.vue on why it must be that entry), and both hand pdf.js
  only `{ url }`, so every pdf.js option (enableXfa among them) stays at its
  default, off. The text and annotation layers are off too, so nothing in the
  PDF is clickable here. scripts/test-load-detail-ratecon.mjs pins all of it.
-->
<template>
  <div ref="tileEl" class="rcv" :class="{ 'rcv-expanded': expanded }">
    <div class="rcv-toolbar" role="toolbar" aria-label="Rate con viewer">
      <div class="rcv-group">
        <button type="button" class="rcv-btn" aria-label="Previous page" title="Previous page" :disabled="!numPages || page <= 1" @click="goPage(page - 1)">&lsaquo;</button>
        <span class="rcv-pages" aria-live="polite">Page {{ page }} of {{ numPages || '…' }}</span>
        <button type="button" class="rcv-btn" aria-label="Next page" title="Next page" :disabled="!numPages || page >= numPages" @click="goPage(page + 1)">&rsaquo;</button>
      </div>
      <div class="rcv-group">
        <button type="button" class="rcv-btn" aria-label="Zoom out" title="Zoom out" :disabled="zoom <= MIN_ZOOM" @click="zoomStep(-1)">&minus;</button>
        <button type="button" class="rcv-btn" aria-label="Zoom in" title="Zoom in" :disabled="zoom >= maxZoom" @click="zoomStep(1)">+</button>
        <button type="button" class="rcv-btn rcv-btn-text" aria-label="Fit to page" title="Fit to page" :aria-pressed="zoom === FIT_ZOOM ? 'true' : 'false'" @click="fitToPage">Fit</button>
        <button type="button" class="rcv-btn rcv-btn-text" :aria-label="isFull ? 'Exit full screen' : 'Full screen'" :title="isFull ? 'Exit full screen' : 'Full screen'" @click="toggleFullscreen">{{ isFull ? 'Exit' : 'Full screen' }}</button>
      </div>
    </div>
    <div ref="stageEl" class="rcv-stage">
      <div class="rcv-page" :style="pinchStyle">
        <component
          :is="pdfComp"
          v-if="pdfComp && src && !failed && renderWidth > 0"
          :source="pdfSource"
          :page="page"
          :width="renderWidth"
          @loaded="onLoaded"
          @rendered="onRendered"
          @loading-failed="onFail"
          @rendering-failed="onFail"
        />
      </div>
      <div v-if="loading && !failed" class="rcv-status" role="status">Loading rate con…</div>
      <div v-if="failed" class="rcv-status rcv-status-fail">
        <span>Couldn't show the rate con here.</span>
        <a :href="src" target="_blank" rel="noopener" class="rcv-open">Open PDF</a>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, shallowRef, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import { FIT_ZOOM, MIN_ZOOM, DEFAULT_PAGE_ASPECT, fitPageWidth, maxZoomFor, clampZoom, stepZoom, clampPage } from '../../lib/rateConView'

const props = defineProps({
  // A blob: URL of the PDF bytes (RateConPdfSection fetched them).
  src: { type: String, default: '' },
})

// Only `{ url }` reaches pdf.js: see the note at the top of this file.
const pdfSource = computed(() => ({ url: props.src }))
// The stage's inner padding on each side (matches .rcv-stage).
const STAGE_PAD = 8

const tileEl = ref(null)
const stageEl = ref(null)
const pdfComp = shallowRef(null)
const doc = shallowRef(null)
const numPages = ref(0)
const page = ref(1)
const zoom = ref(FIT_ZOOM)
const aspect = ref(DEFAULT_PAGE_ASPECT)
const stageW = ref(0)
const stageH = ref(0)
const loading = ref(true)
const failed = ref(false)
const expanded = ref(false)       // CSS full screen, where the Fullscreen API is missing (iPhone)
const nativeFull = ref(false)     // the Fullscreen API's own state
const pinchScale = ref(1)
const isFull = computed(() => expanded.value || nativeFull.value)
const dpr = typeof window !== 'undefined' && window.devicePixelRatio > 0 ? window.devicePixelRatio : 1

const fitWidth = computed(() => fitPageWidth(stageW.value, stageH.value, aspect.value))
const maxZoom = computed(() => maxZoomFor(fitWidth.value, aspect.value, dpr))
const renderWidth = computed(() => Math.floor(fitWidth.value * zoom.value))
// Live feedback while two fingers move; committed as a real zoom on release.
const pinchStyle = computed(() => (pinchScale.value === 1 ? null : { transform: `scale(${pinchScale.value})`, transformOrigin: 'center top' }))

function measure() {
  const el = stageEl.value
  if (!el) return
  stageW.value = Math.max(0, el.clientWidth - STAGE_PAD * 2)
  stageH.value = Math.max(0, el.clientHeight - STAGE_PAD * 2)
}

// The page's own shape decides what "fit" means (landscape pages exist).
let aspectSeq = 0
function updateAspect() {
  const d = doc.value
  if (!d) return
  const seq = ++aspectSeq
  d.getPage(page.value).then((p) => {
    if (seq !== aspectSeq) return
    const v = p.getViewport({ scale: 1 })
    if (v && v.width > 0 && v.height > 0) aspect.value = v.height / v.width
  }).catch(() => {})
}

function onLoaded(d) {
  doc.value = d
  numPages.value = Math.max(1, Number(d && d.numPages) || 1)
  page.value = clampPage(page.value, numPages.value)
  updateAspect()
}
function onRendered() {
  loading.value = false
  failed.value = false
}
function onFail() {
  failed.value = true
  loading.value = false
}

function scrollToTop() {
  const el = stageEl.value
  if (el) { el.scrollTop = 0; el.scrollLeft = 0 }
}
function goPage(n) {
  page.value = clampPage(n, numPages.value)
}
// Keep the point at the stage's centre in place across a zoom.
function setZoom(next) {
  const el = stageEl.value
  const target = clampZoom(next, maxZoom.value)
  if (target === zoom.value) return
  const cx = el && el.scrollWidth ? (el.scrollLeft + el.clientWidth / 2) / el.scrollWidth : 0.5
  const cy = el && el.scrollHeight ? (el.scrollTop + el.clientHeight / 2) / el.scrollHeight : 0
  zoom.value = target
  nextTick(() => {
    if (!el) return
    el.scrollLeft = Math.max(0, cx * el.scrollWidth - el.clientWidth / 2)
    el.scrollTop = Math.max(0, cy * el.scrollHeight - el.clientHeight / 2)
  })
}
function zoomStep(direction) {
  setZoom(stepZoom(zoom.value, direction, maxZoom.value))
}
function fitToPage() {
  zoom.value = FIT_ZOOM
  nextTick(scrollToTop)
}

function toggleFullscreen() {
  if (nativeFull.value && typeof document !== 'undefined' && document.fullscreenElement) {
    document.exitFullscreen().catch(() => {})
    return
  }
  if (expanded.value) { expanded.value = false; return }
  const el = tileEl.value
  if (el && typeof el.requestFullscreen === 'function' && document.fullscreenEnabled) {
    el.requestFullscreen().catch(() => { expanded.value = true })
  } else {
    expanded.value = true
  }
}
function onFullscreenChange() {
  nativeFull.value = !!tileEl.value && document.fullscreenElement === tileEl.value
}

// Two-finger pinch. Touch events rather than pointer events: once the browser
// starts scrolling a one-finger pan it cancels that pointer, and the second
// finger would then arrive alone.
let pinch = null
const touchDist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY)
function onTouchStart(e) {
  if (e.touches.length === 2) pinch = { dist: touchDist(e.touches) || 1, zoom: zoom.value }
}
function onTouchMove(e) {
  if (!pinch || e.touches.length !== 2) return
  e.preventDefault()
  const target = clampZoom(pinch.zoom * (touchDist(e.touches) / pinch.dist), maxZoom.value)
  pinchScale.value = target / zoom.value
}
function onTouchEnd(e) {
  if (!pinch || e.touches.length >= 2) return
  const target = zoom.value * pinchScale.value
  pinch = null
  pinchScale.value = 1
  setZoom(target)
}

// vue-pdf-embed's essential entry, lazily, with its worker wired: the same two
// imports PdfZoomViewer.vue makes (its comments explain both).
async function loadPdfComp() {
  try {
    const [mod, worker] = await Promise.all([
      import('vue-pdf-embed/dist/index.essential.mjs'),
      import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'),
    ])
    mod.GlobalWorkerOptions.workerSrc = worker.default
    pdfComp.value = mod.default
  } catch {
    onFail()
  }
}

watch(() => props.src, () => {
  doc.value = null
  numPages.value = 0
  page.value = 1
  zoom.value = FIT_ZOOM
  aspect.value = DEFAULT_PAGE_ASPECT
  loading.value = true
  failed.value = false
  scrollToTop()
})
watch(page, () => {
  updateAspect()
  scrollToTop()
})

let ro = null
onMounted(() => {
  measure()
  loadPdfComp()
  const el = stageEl.value
  if (el) {
    if ('ResizeObserver' in window) {
      ro = new ResizeObserver(measure)
      ro.observe(el)
    }
    el.addEventListener('touchstart', onTouchStart, { passive: true })
    el.addEventListener('touchmove', onTouchMove, { passive: false })
    el.addEventListener('touchend', onTouchEnd, { passive: true })
    el.addEventListener('touchcancel', onTouchEnd, { passive: true })
  }
  document.addEventListener('fullscreenchange', onFullscreenChange)
})
onBeforeUnmount(() => {
  ro?.disconnect()
  ro = null
  const el = stageEl.value
  if (el) {
    el.removeEventListener('touchstart', onTouchStart)
    el.removeEventListener('touchmove', onTouchMove)
    el.removeEventListener('touchend', onTouchEnd)
    el.removeEventListener('touchcancel', onTouchEnd)
  }
  document.removeEventListener('fullscreenchange', onFullscreenChange)
  if (nativeFull.value && document.fullscreenElement) document.exitFullscreen().catch(() => {})
})
</script>

<style scoped>
.rcv {
  display: flex; flex-direction: column; max-width: 100%;
  height: min(72vh, 760px);
  border: 1px solid #e5e7eb; border-radius: 8px; overflow: hidden; background: #f1f5f9;
}
@media (max-width: 640px) {
  .rcv { height: 65vh; }
}
.rcv:fullscreen { height: 100%; border-radius: 0; border: 0; }
.rcv-expanded { position: fixed; inset: 0; z-index: 70; height: auto; border-radius: 0; border: 0; }

.rcv-toolbar {
  display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between;
  gap: 0.25rem 0.5rem; padding: 0.35rem 0.5rem; background: #fff; border-bottom: 1px solid #e5e7eb;
}
.rcv-group { display: flex; align-items: center; gap: 0.25rem; }
.rcv-btn {
  min-width: 36px; height: 36px; padding: 0 0.5rem;
  display: inline-flex; align-items: center; justify-content: center;
  border: 1px solid #e5e7eb; border-radius: 6px; background: #fff; color: #111827;
  font-size: 1.05rem; font-weight: 600; line-height: 1; cursor: pointer;
}
.rcv-btn-text { font-size: 0.78rem; }
.rcv-btn:hover:not(:disabled) { background: #f3f4f6; }
.rcv-btn:disabled { opacity: 0.4; cursor: default; }
.rcv-pages { font-size: 0.78rem; color: #374151; min-width: 5.5rem; text-align: center; font-variant-numeric: tabular-nums; }

.rcv-stage {
  position: relative; flex: 1; min-height: 0; min-width: 0;
  display: flex; overflow: auto; padding: 8px;
  touch-action: pan-x pan-y; -webkit-overflow-scrolling: touch;
}
/* margin:auto centres a page smaller than the stage and still scrolls one
   larger than it (centring with justify-content would clip its left edge). */
.rcv-page { margin: auto; flex: none; background: #fff; box-shadow: 0 1px 3px rgba(15, 23, 42, 0.18); }

.rcv-status {
  position: absolute; inset: 0; display: flex; flex-direction: column; gap: 0.4rem;
  align-items: center; justify-content: center; text-align: center;
  font-size: 0.82rem; color: #6b7280; pointer-events: none;
}
.rcv-status-fail { pointer-events: auto; background: #f1f5f9; }
.rcv-open { color: #2563eb; font-weight: 600; }
</style>
