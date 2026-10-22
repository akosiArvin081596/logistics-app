<!--
  A one-page-at-a-time PDF viewer for the load-detail rate con tile
  (RateConPdfSection.vue): the WHOLE page fits the tile by default, with zoom
  in / zoom out / fit to page, previous / next page ("Page X of Y") and full
  screen. The mouse wheel (or a trackpad pinch) over the page zooms about the
  pointer, a zoomed page is dragged around, and on a phone two fingers pinch
  and one finger moves a zoomed page. At fit a swipe scrolls the dialog as usual.

  No blank frame, no jump (B22): the tile never changes size, and the page is
  moved and zoomed with a CSS transform at once. After a short pause the page
  is drawn sharp at the new zoom into a NEW canvas off screen, which then
  replaces the one on screen in a single step: a canvas on screen is never
  resized or cleared. rateConZoom.js holds the maths (where the page sits, the
  pointer-anchored zoom, the pan bounds, the pinch); scripts/test-ratecon-
  viewer-zoom.mjs pins it and this component.

  ⚠️ Why not PdfZoomViewer.vue: that viewer is shared by the invoice screens,
  payout statements and signing documents, stacks every page at fit-to-WIDTH,
  and changing it would change how those other screens look and behave.
  Why not vue-pdf-embed's component any more: it resizes (so clears) its canvas
  before each draw, which was the blank frame on every zoom step. The document
  is still opened by the same vue-pdf-embed ESSENTIAL entry (see the long note
  in PdfZoomViewer.vue on why it must be that entry), through usePdfDocument(),
  the loader its component uses, handed only `{ url }`, so every pdf.js option
  (enableXfa among them) stays at its default, off. A page is drawn with
  page.render({ canvas, viewport }), the call the component makes. There is no
  text or annotation layer, so nothing in the PDF is clickable here.
  scripts/test-load-detail-ratecon.mjs pins all of it.
-->
<template>
  <div ref="tileEl" class="rcv" :class="{ 'rcv-expanded': expanded }" :style="tileStyle">
    <div class="rcv-toolbar" role="toolbar" aria-label="Rate con viewer">
      <div class="rcv-group">
        <button type="button" class="rcv-btn" aria-label="Previous page" title="Previous page" :disabled="!numPages || page <= 1" @click="goPage(page - 1)">&lsaquo;</button>
        <span class="rcv-pages" aria-live="polite">Page {{ page }} of {{ numPages || '…' }}</span>
        <button type="button" class="rcv-btn" aria-label="Next page" title="Next page" :disabled="!numPages || page >= numPages" @click="goPage(page + 1)">&rsaquo;</button>
      </div>
      <div class="rcv-group">
        <button type="button" class="rcv-btn" aria-label="Zoom out" title="Zoom out" :disabled="!shown || atMin" @click="zoomStep(-1)">&minus;</button>
        <button type="button" class="rcv-btn" aria-label="Zoom in" title="Zoom in" :disabled="!shown || atMax" @click="zoomStep(1)">+</button>
        <button type="button" class="rcv-btn rcv-btn-text" aria-label="Fit to page" title="Fit to page" :aria-pressed="zoom === FIT_ZOOM ? 'true' : 'false'" @click="fitToPage">Fit</button>
        <button type="button" class="rcv-btn rcv-btn-text" :aria-label="isFull ? 'Exit full screen' : 'Full screen'" :title="isFull ? 'Exit full screen' : 'Full screen'" @click="toggleFullscreen">
          <svg class="rcv-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path v-if="isFull" d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" />
            <path v-else d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
          </svg>
          <span class="rcv-btn-label">{{ isFull ? 'Exit' : 'Full screen' }}</span>
        </button>
      </div>
    </div>
    <div
      ref="stageEl"
      class="rcv-stage"
      :class="{ 'rcv-pannable': pannable, 'rcv-dragging': dragging }"
      tabindex="0"
      role="region"
      :aria-label="`Rate con page ${page} of ${numPages || 1}`"
      :aria-describedby="hintId"
      @keydown="onStageKey"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
      @lostpointercapture="onPointerUp"
    >
      <!-- The canvas goes in here from the script (swapIn), never from the template. -->
      <div ref="pageEl" class="rcv-page" :class="{ 'rcv-page-shown': shown }" :style="pageStyle"></div>
      <p :id="hintId" class="rcv-sr-only">Scroll or pinch to zoom. Drag, or use the arrow keys, to move a zoomed page. Plus, minus and 0 zoom in, zoom out and fit.</p>
      <div v-if="loading && !failed" class="rcv-status" role="status">Loading rate con…</div>
      <!-- No "open the file" link: the PDF is only ever shown in this viewer. -->
      <div v-if="failed" class="rcv-status rcv-status-fail">Couldn't show the rate con here.</div>
    </div>
  </div>
</template>

<script setup>
import { ref, shallowRef, computed, watch, nextTick, effectScope, useId, onMounted, onBeforeUnmount } from 'vue'
import { FIT_ZOOM, MIN_ZOOM, MAX_ZOOM, DEFAULT_PAGE_ASPECT, stepZoom, clampPage, tileMaxHeight } from '../../lib/rateConView'
import { fitSize, fitView, clampView, zoomAt, panBy, pinchStep, wheelZoomFactor, renderDensity, canvasPixelCap, keepCentre, pageTopView } from '../../lib/rateConZoom'

const props = defineProps({
  // A blob: URL of the PDF bytes (RateConPdfSection fetched them).
  src: { type: String, default: '' },
})

// Only `{ url }` reaches pdf.js: see the note at the top of this file.
const pdfSource = computed(() => ({ url: props.src }))
// Nothing is opened until there is a file to open.
const docSource = computed(() => (props.src ? pdfSource.value : null))

// The pause after the last zoom input before the page is drawn sharp again.
const RENDER_DELAY_MS = 160
const KEY_PAN_PX = 48
const hintId = `rcv-hint-${useId()}`

const tileEl = ref(null)
const stageEl = ref(null)
const pageEl = ref(null)
const doc = shallowRef(null)
const numPages = ref(0)
const page = ref(1)
const aspect = ref(DEFAULT_PAGE_ASPECT)
const stage = shallowRef({ w: 0, h: 0, gap: 8 })
// Where the page is and how far it is zoomed (rateConZoom.js).
const view = shallowRef({ zoom: FIT_ZOOM, x: 0, y: 0 })
// The zoom the canvas on screen was drawn at; the transform makes up the rest.
const renderZoom = ref(FIT_ZOOM)
const shown = ref(false)          // a drawn page is on screen
const loading = ref(true)
const failed = ref(false)
const dragging = ref(false)
const expanded = ref(false)       // CSS full screen, where the Fullscreen API is missing (iPhone)
const nativeFull = ref(false)     // the Fullscreen API's own state
const isFull = computed(() => expanded.value || nativeFull.value)

const dpr = () => (typeof window !== 'undefined' && window.devicePixelRatio > 0 ? window.devicePixelRatio : 1)
// How big a canvas this device takes (rateConZoom.js canvasPixelCap()), read once.
function deviceTraits() {
  if (typeof window === 'undefined') return {}
  const nav = window.navigator || {}
  const coarse = typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches
  return { userAgent: nav.userAgent, platform: nav.platform, maxTouchPoints: nav.maxTouchPoints, coarsePointer: !!coarse }
}
const canvasCap = canvasPixelCap(deviceTraits())
// A narrow (phone) stage keeps a smaller margin round the page.
const gapFor = (w) => (w > 0 && w < 480 ? 4 : 8)

const fit = computed(() => fitSize(stage.value, aspect.value))
const zoom = computed(() => view.value.zoom)
const atMin = computed(() => zoom.value <= MIN_ZOOM)
const atMax = computed(() => zoom.value >= MAX_ZOOM)
const pannable = computed(() => zoom.value > FIT_ZOOM)
const pageStyle = computed(() => {
  const f = fit.value
  const rz = renderZoom.value
  const v = view.value
  const scale = v.zoom / rz
  // At rest the page sits on whole device pixels, so its text stays crisp.
  const d = dpr()
  const at = (n) => (scale === 1 ? Math.round(n * d) / d : n)
  return { width: `${f.w * rz}px`, height: `${f.h * rz}px`, transform: `translate(${at(v.x)}px, ${at(v.y)}px) scale(${scale})` }
})

// The tile never stands taller than the scroll area it sits in (the dialog
// body), so the controls and the whole fitted page are on screen together.
// The CSS height is the size; this is only its ceiling, and full screen has none.
const tileCap = ref(0)
const tileStyle = computed(() => (!isFull.value && tileCap.value > 0 ? { maxHeight: `${tileCap.value}px` } : null))
let scrollArea = null
function findScrollArea() {
  let el = tileEl.value && tileEl.value.parentElement
  while (el && el !== document.body) {
    const oy = getComputedStyle(el).overflowY
    if (oy === 'auto' || oy === 'scroll') return el
    el = el.parentElement
  }
  return null
}
function measureCap() {
  if (!scrollArea) return
  const cs = getComputedStyle(scrollArea)
  tileCap.value = tileMaxHeight(scrollArea.clientHeight, parseFloat(cs.paddingTop), parseFloat(cs.paddingBottom))
}

// The stage changed size: keep the zoom and the page point at its centre.
function measure() {
  const el = stageEl.value
  if (!el) return
  const w = Math.max(0, Number(el.clientWidth) || 0)
  const h = Math.max(0, Number(el.clientHeight) || 0)
  const prev = stage.value
  if (w === prev.w && h === prev.h) return
  const prevFit = fit.value
  const next = { w, h, gap: gapFor(w) }
  stage.value = next
  view.value = keepCentre(view.value, prev, prevFit, next, fitSize(next, aspect.value))
  if (!doc.value) return
  if (shown.value) scheduleRender()
  else showPage(page.value)
}

// ── Drawing ──────────────────────────────────────────────────────────────────
let renderSeq = 0
let renderTimer = null
let renderTask = null
let onScreen = null
let shownPage = 0 // the page number the canvas on screen shows
let shownFitW = 0 // and the fit width it was drawn for (the stage's size then)

function freeCanvas(c) {
  // Only ever a canvas that is off screen. Zero size hands its memory back
  // at once (iOS Safari caps the total).
  if (c) { c.width = 0; c.height = 0 }
}
function cancelRender() {
  renderSeq++
  if (renderTimer) { clearTimeout(renderTimer); renderTimer = null }
  if (renderTask) { renderTask.cancel(); renderTask = null }
}
function scheduleRender() {
  cancelRender()
  renderTimer = setTimeout(() => {
    renderTimer = null
    // A page change this pause cut short still opens its page at the top.
    if (shownPage === page.value) drawPage(page.value, null)
    else showPage(page.value)
  }, RENDER_DELAY_MS)
}

// Draw page `n` sharp into a new canvas off screen, then swap it in. `place`
// gives the view a NEW page opens at (from its own fit); null keeps the view.
async function drawPage(n, place) {
  const d = doc.value
  if (!d || !(stage.value.w > 0)) return
  const seq = ++renderSeq
  let p
  try {
    p = await d.getPage(n)
  } catch (err) {
    drawFailed(seq, place, err)
    return
  }
  if (seq !== renderSeq) return
  const base = p.getViewport({ scale: 1 })
  if (!base || !(base.width > 0) || !(base.height > 0)) { drawFailed(seq, place, new Error('the page has no size')); return }
  const a = base.height / base.width
  const f = fitSize(stage.value, a)
  const target = place ? place(f) : clampView(view.value, stage.value, f)
  const cssW = f.w * target.zoom
  const cssH = f.h * target.zoom
  if (!(cssW > 0) || !(cssH > 0)) return
  const viewport = p.getViewport({ scale: (cssW / base.width) * renderDensity(cssW, cssH, dpr(), canvasCap) })
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.floor(viewport.width))
  canvas.height = Math.max(1, Math.floor(viewport.height))
  const task = p.render({ canvas, viewport })
  renderTask = task
  try {
    await task.promise
  } catch (err) {
    if (renderTask === task) renderTask = null
    freeCanvas(canvas)
    if (!(err && err.name === 'RenderingCancelledException')) drawFailed(seq, place, err)
    return
  }
  if (renderTask === task) renderTask = null
  if (seq !== renderSeq) { freeCanvas(canvas); return }
  // Everything below runs before the browser paints again: the new page, its
  // place and the swap show up in one frame.
  if (place || a !== aspect.value) view.value = target
  aspect.value = a
  swapIn(canvas, target.zoom, n, f.w)
}
// A draw that failed. A sharp re-draw of the page already on screen keeps that
// page (still right, only softer until the next zoom) and logs; a new page or
// the first draw shows the failure message.
function drawFailed(seq, place, err) {
  if (seq !== renderSeq) return
  if (!place && shown.value && shownPage === page.value) {
    console.warn('[rate con viewer] sharp re-draw failed, keeping the page on screen:', err && err.message ? err.message : err)
    return
  }
  onFail()
}
// The new canvas goes in before the old one comes out, so the page box is
// never empty; the old one is freed only once it is off screen.
function swapIn(canvas, drawnZoom, pageNo, fitW) {
  const host = pageEl.value
  if (!host) { freeCanvas(canvas); return }
  canvas.style.cssText = 'display:block;width:100%;height:100%;'
  canvas.setAttribute('aria-hidden', 'true')
  const old = onScreen
  renderZoom.value = drawnZoom
  host.appendChild(canvas)
  if (old) {
    if (old.parentNode === host) host.removeChild(old)
    freeCanvas(old)
  }
  onScreen = canvas
  shownPage = pageNo
  shownFitW = fitW
  shown.value = true
  loading.value = false
  failed.value = false
}
function removeShown() {
  const host = pageEl.value
  if (onScreen && host && onScreen.parentNode === host) host.removeChild(onScreen)
  freeCanvas(onScreen)
  onScreen = null
  shownPage = 0
  shownFitW = 0
  shown.value = false
}

function onDoc(d) {
  if (!d) return
  doc.value = d
  numPages.value = Math.max(1, Number(d.numPages) || 1)
  page.value = clampPage(page.value, numPages.value)
  showPage(page.value)
}
// A page opens at the same zoom and column, at its top.
function showPage(n) {
  cancelRender()
  const { zoom: z, x } = view.value
  drawPage(n, (f) => pageTopView(z, x, stage.value, f))
}
function onFail() {
  cancelRender()
  failed.value = true
  loading.value = false
}

// ── Zoom and pan ─────────────────────────────────────────────────────────────
function setView(next) {
  if (next === view.value) return
  const rezoom = next.zoom !== view.value.zoom
  view.value = next
  // Moved by hand in full screen: leaving it keeps this place (restoreView).
  if (isFull.value) savedView = null
  if (!rezoom) return
  // Back at the zoom the canvas on screen was drawn at: it is already sharp,
  // unless a page change is on its way or the stage has changed size since.
  if (next.zoom === renderZoom.value && shownPage === page.value && shownFitW === fit.value.w) cancelRender()
  else scheduleRender()
}
function stagePoint(clientX, clientY) {
  const el = stageEl.value
  const r = el && typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : { left: 0, top: 0 }
  return { x: clientX - r.left, y: clientY - r.top }
}
function zoomAround(nextZoom, x, y) {
  setView(zoomAt(view.value, nextZoom, x, y, stage.value, fit.value))
}
// The buttons zoom about the middle of what is on screen.
function zoomStep(direction) {
  zoomAround(stepZoom(zoom.value, direction), stage.value.w / 2, stage.value.h / 2)
}
function fitToPage() {
  setView(fitView(stage.value, fit.value))
}
function goPage(n) {
  page.value = clampPage(n, numPages.value)
}

// Over the page the wheel zooms and the page behind does not scroll; anywhere
// else it scrolls as usual (the listener is on this stage only).
function onWheel(e) {
  if (!shown.value || failed.value) return
  e.preventDefault()
  const k = wheelZoomFactor(e.deltaY, e.deltaMode, e.ctrlKey)
  if (k === 1) return
  const p = stagePoint(e.clientX, e.clientY)
  zoomAround(zoom.value * k, p.x, p.y)
}

// Mouse and pen: drag a zoomed page. Touch has its own handlers below.
let drag = null
function onPointerDown(e) {
  if (e.pointerType === 'touch' || e.button !== 0 || !pannable.value || !shown.value) return
  // No text selection or image drag; the stage takes focus for the arrow keys.
  e.preventDefault()
  const el = stageEl.value
  if (el && typeof el.focus === 'function') el.focus({ preventScroll: true })
  if (el && typeof el.setPointerCapture === 'function') el.setPointerCapture(e.pointerId)
  drag = { id: e.pointerId, x: e.clientX, y: e.clientY }
  dragging.value = true
}
function onPointerMove(e) {
  if (!drag || e.pointerId !== drag.id) return
  const dx = e.clientX - drag.x
  const dy = e.clientY - drag.y
  drag.x = e.clientX
  drag.y = e.clientY
  setView(panBy(view.value, dx, dy, stage.value, fit.value))
}
function onPointerUp(e) {
  if (!drag || e.pointerId !== drag.id) return
  const el = stageEl.value
  if (el && typeof el.hasPointerCapture === 'function' && el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId)
  drag = null
  dragging.value = false
}

// Keyboard, with the page area focused: arrows move a zoomed page, + / - / 0
// zoom. At fit the arrows are left to scroll the dialog.
function onStageKey(e) {
  if (!shown.value || failed.value || e.altKey || e.metaKey || e.ctrlKey) return
  const step = e.shiftKey ? KEY_PAN_PX * 3 : KEY_PAN_PX
  const pan = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] }[e.key]
  if (pan) {
    if (!pannable.value) return
    setView(panBy(view.value, pan[0], pan[1], stage.value, fit.value))
  } else if (e.key === '+' || e.key === '=') {
    zoomStep(1)
  } else if (e.key === '-' || e.key === '_') {
    zoomStep(-1)
  } else if (e.key === '0') {
    fitToPage()
  } else {
    return
  }
  e.preventDefault()
}

// Phone: two fingers pinch about their midpoint, one finger moves a zoomed
// page. At fit one finger is left alone, so a swipe scrolls the dialog
// (touch-action pan-x pan-y); zoomed, the stage takes every touch
// (touch-action none). Touch events rather than pointer events: once the
// browser starts scrolling a one-finger pan it cancels that pointer, and the
// second finger would then arrive alone.
let touch = null
let touchCount = 0
function fingers(e) {
  const t = e.touches
  if (t.length >= 2) {
    const mid = stagePoint((t[0].clientX + t[1].clientX) / 2, (t[0].clientY + t[1].clientY) / 2)
    return { kind: 'pinch', dist: Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY), x: mid.x, y: mid.y }
  }
  if (t.length === 1 && pannable.value) return { kind: 'pan', x: t[0].clientX, y: t[0].clientY }
  return null
}
function onTouchStart(e) {
  touchCount = e.touches.length
  touch = shown.value ? fingers(e) : null
}
function onTouchMove(e) {
  if (!touch) return
  const next = fingers(e)
  if (!next || next.kind !== touch.kind) { touch = next; return }
  if (e.cancelable) e.preventDefault()
  if (next.kind === 'pinch') setView(pinchStep(view.value, touch, next, stage.value, fit.value))
  else setView(panBy(view.value, next.x - touch.x, next.y - touch.y, stage.value, fit.value))
  touch = next
}
function onTouchEnd(e) {
  touchCount = e.touches.length
  touch = shown.value ? fingers(e) : null
}
// Safari on a Mac sends a trackpad pinch as gesture events, not ctrl + wheel.
// On an iPhone the touch handlers have the pinch already; these then only stop
// Safari zooming the whole page.
let gesture = null
function onGestureStart(e) {
  e.preventDefault()
  gesture = touchCount === 0 && shown.value ? { scale: 1 } : null
}
function onGestureChange(e) {
  e.preventDefault()
  if (!gesture || !(e.scale > 0)) return
  const p = stagePoint(e.clientX, e.clientY)
  zoomAround(zoom.value * (e.scale / gesture.scale), p.x, p.y)
  gesture.scale = e.scale
}
function onGestureEnd(e) {
  e.preventDefault()
  gesture = null
}

// ── Full screen ──────────────────────────────────────────────────────────────
// Leaving full screen puts the view back as it was before (same zoom and
// place). If the page was zoomed, moved or changed in full screen, it keeps
// that instead: the same zoom, the same point in the middle. The dialog behind
// gets its own scroll back too (the browser can move it on the way out).
let savedView = null
let savedAreaTop = null
watch(isFull, (full, was) => {
  if (full && !was) {
    savedView = { view: view.value, stage: stage.value, fit: fit.value }
  } else if (!full && was) {
    nextTick(restoreView)
  }
})
function restoreView() {
  const saved = savedView
  savedView = null
  if (scrollArea && savedAreaTop !== null) scrollArea.scrollTop = savedAreaTop
  savedAreaTop = null
  measure()
  if (!saved) return
  const s = stage.value
  const f = fit.value
  const same = s.w === saved.stage.w && s.h === saved.stage.h && f.w === saved.fit.w
  setView(same ? saved.view : keepCentre(saved.view, saved.stage, saved.fit, s, f))
}

function toggleFullscreen() {
  if (nativeFull.value && typeof document !== 'undefined' && document.fullscreenElement) {
    document.exitFullscreen().catch(() => {})
    return
  }
  if (expanded.value) { expanded.value = false; return }
  // Before asking: by the time full screen is reported the browser has
  // already scrolled the dialog behind.
  savedAreaTop = scrollArea ? scrollArea.scrollTop : null
  const el = tileEl.value
  if (el && typeof el.requestFullscreen === 'function' && document.fullscreenEnabled) {
    el.requestFullscreen().catch(() => { expanded.value = true })
  } else {
    expanded.value = true
  }
}
// Escape in full screen leaves full screen and nothing else. The load dialog
// closes on Escape too (reka-ui listens on window, in the bubble phase), so this
// listens on window in the CAPTURE phase, which runs first, and stops the
// event there.
//
// ⚠️ The browser leaves NATIVE full screen on that same Escape by itself, and
// its fullscreenchange can be handled before the keydown, so by then
// document.fullscreenElement is already null. An Escape that comes within
// ESC_GRACE_MS of leaving full screen is therefore still the viewer's. Both
// times are the EVENTS' own timestamps (when they happened), not the clock
// when a handler finally runs: the first full-screen exit re-renders the page
// at a new size, and a busy main thread used to push the keydown's handler
// past a wall-clock window (1 run in 7 closed the dialog).
const ESC_GRACE_MS = 500
let fullExitedTs = -Infinity
function eventTime(e) {
  const t = Number(e && e.timeStamp)
  return t > 0 ? t : performance.now()
}
function onFullscreenChange(e) {
  const wasFull = nativeFull.value
  nativeFull.value = !!tileEl.value && document.fullscreenElement === tileEl.value
  if (wasFull && !nativeFull.value) fullExitedTs = eventTime(e)
}
function onKeydown(e) {
  if (e.key !== 'Escape' && e.key !== 'Esc') return
  // Negative when the key was pressed before the exit was reported: also ours.
  const justLeft = eventTime(e) - fullExitedTs <= ESC_GRACE_MS
  if (!isFull.value && !justLeft) return
  e.preventDefault()
  e.stopImmediatePropagation()
  e.stopPropagation()
  if (expanded.value) expanded.value = false
  else if (nativeFull.value && document.fullscreenElement) document.exitFullscreen().catch(() => {})
}

// ── Loading ──────────────────────────────────────────────────────────────────
// vue-pdf-embed's essential entry, lazily, with its worker wired: the same two
// imports PdfZoomViewer.vue makes (its comments explain both). The document's
// loader runs in its own effect scope, stopped on unmount, which destroys the
// loading task and the document with it.
let docScope = null
let disposed = false
async function loadPdf() {
  try {
    const [mod, worker] = await Promise.all([
      import('vue-pdf-embed/dist/index.essential.mjs'),
      import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'),
    ])
    mod.GlobalWorkerOptions.workerSrc = worker.default
    if (disposed) return
    docScope = effectScope(true)
    docScope.run(() => {
      const { doc: loaded } = mod.usePdfDocument({ source: docSource, onError: onFail })
      watch(loaded, onDoc, { immediate: true })
    })
  } catch {
    onFail()
  }
}

watch(() => props.src, () => {
  cancelRender()
  removeShown()
  doc.value = null
  numPages.value = 0
  page.value = 1
  aspect.value = DEFAULT_PAGE_ASPECT
  view.value = fitView(stage.value, fitSize(stage.value, DEFAULT_PAGE_ASPECT))
  renderZoom.value = FIT_ZOOM
  loading.value = true
  failed.value = false
})
watch(page, (n, old) => {
  if (n === old) return
  savedView = null
  showPage(n)
})

let ro = null
let areaRo = null
onMounted(() => {
  measure()
  loadPdf()
  const el = stageEl.value
  if (el) {
    if ('ResizeObserver' in window) {
      ro = new ResizeObserver(measure)
      ro.observe(el)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    el.addEventListener('touchstart', onTouchStart, { passive: true })
    el.addEventListener('touchmove', onTouchMove, { passive: false })
    el.addEventListener('touchend', onTouchEnd, { passive: true })
    el.addEventListener('touchcancel', onTouchEnd, { passive: true })
    el.addEventListener('gesturestart', onGestureStart, { passive: false })
    el.addEventListener('gesturechange', onGestureChange, { passive: false })
    el.addEventListener('gestureend', onGestureEnd, { passive: false })
  }
  scrollArea = findScrollArea()
  measureCap()
  if (scrollArea && 'ResizeObserver' in window) {
    areaRo = new ResizeObserver(measureCap)
    areaRo.observe(scrollArea)
  }
  document.addEventListener('fullscreenchange', onFullscreenChange)
  window.addEventListener('keydown', onKeydown, true)
})
onBeforeUnmount(() => {
  disposed = true
  cancelRender()
  removeShown()
  docScope?.stop()
  docScope = null
  ro?.disconnect()
  ro = null
  areaRo?.disconnect()
  areaRo = null
  scrollArea = null
  window.removeEventListener('keydown', onKeydown, true)
  const el = stageEl.value
  if (el) {
    el.removeEventListener('wheel', onWheel)
    el.removeEventListener('touchstart', onTouchStart)
    el.removeEventListener('touchmove', onTouchMove)
    el.removeEventListener('touchend', onTouchEnd)
    el.removeEventListener('touchcancel', onTouchEnd)
    el.removeEventListener('gesturestart', onGestureStart)
    el.removeEventListener('gesturechange', onGestureChange)
    el.removeEventListener('gestureend', onGestureEnd)
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
  .rcv { height: 55vh; }
}
.rcv:fullscreen { height: 100%; border-radius: 0; border: 0; }
.rcv-expanded {
  position: fixed; inset: 0; z-index: 70; height: auto; border-radius: 0; border: 0;
  /* Full screen: keep the toolbar and pages clear of a notched iPhone's notch and home bar. */
  padding: env(safe-area-inset-top, 0px) env(safe-area-inset-right, 0px) env(safe-area-inset-bottom, 0px) env(safe-area-inset-left, 0px);
}

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
.rcv-btn:focus-visible { outline: 2px solid #2563eb; outline-offset: 1px; }
.rcv-icon { display: none; width: 18px; height: 18px; }
.rcv-pages { font-size: 0.78rem; color: #374151; min-width: 5.5rem; text-align: center; font-variant-numeric: tabular-nums; }
/* One toolbar row on a phone, so the page gets the height (and with it the
   width). After the rules it overrides. */
@media (max-width: 640px) {
  .rcv-toolbar { padding: 0.25rem; gap: 0.25rem; }
  .rcv-group { gap: 0.2rem; }
  .rcv-pages { min-width: 4.6rem; }
  .rcv-btn-label { display: none; }
  .rcv-icon { display: block; }
}

/* The page area never scrolls itself and never changes size: the page is
   placed and zoomed inside it with a transform. */
.rcv-stage {
  position: relative; flex: 1; min-height: 0; min-width: 0;
  overflow: hidden; outline: none;
  touch-action: pan-x pan-y;
  user-select: none; -webkit-user-select: none;
}
/* The focus ring is a last child laid over the stage, so it paints above a
   zoomed page that fills it. */
.rcv-stage:focus-visible::after {
  content: ''; position: absolute; inset: 0; pointer-events: none;
  box-shadow: inset 0 0 0 2px #2563eb;
}
.rcv-pannable { touch-action: none; cursor: grab; }
.rcv-dragging { cursor: grabbing; }
.rcv-page {
  position: absolute; left: 0; top: 0;
  transform-origin: 0 0; will-change: transform;
  background: #fff; box-shadow: 0 1px 3px rgba(15, 23, 42, 0.18);
  visibility: hidden;
}
.rcv-page-shown { visibility: visible; }
.rcv-sr-only {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0;
}

.rcv-status {
  position: absolute; inset: 0; display: flex; flex-direction: column; gap: 0.4rem;
  align-items: center; justify-content: center; text-align: center;
  font-size: 0.82rem; color: #6b7280; pointer-events: none;
}
.rcv-status-fail { pointer-events: auto; background: #f1f5f9; }
</style>
