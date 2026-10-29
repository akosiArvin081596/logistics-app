<template>
  <Teleport to="body" :disabled="inline">
    <div
      v-if="src"
      ref="overlayRef"
      :class="inline ? 'zoom-inline' : 'zoom-overlay'"
      :role="inline ? undefined : 'dialog'"
      :aria-modal="inline ? undefined : 'true'"
      :aria-label="alt"
      :tabindex="inline ? undefined : -1"
      @click.self="onBackdropClick"
      @wheel.prevent="onWheel"
    >
      <img
        ref="imgRef"
        :src="src"
        :alt="alt"
        class="zoom-img"
        :class="{ panning: scale > 1, 'no-transition': isInteracting }"
        :style="imgStyle"
        draggable="false"
        @pointerdown="onPointerDown"
        @pointermove="onPointerMove"
        @pointerup="onPointerUp"
        @pointercancel="onPointerUp"
        @dblclick="onDoubleClick"
      />

      <p v-if="gallery && position" class="zoom-position" aria-live="polite">{{ position }}</p>
      <!-- aria-disabled rather than disabled at either end: a disabled button
           drops the focus it holds, and focus must stay inside the viewer. -->
      <button
        v-if="gallery"
        type="button"
        class="zoom-nav zoom-prev"
        aria-label="Previous photo"
        :aria-disabled="hasPrev ? 'false' : 'true'"
        @click="goPrev"
      >&lsaquo;</button>
      <button
        v-if="gallery"
        type="button"
        class="zoom-nav zoom-next"
        aria-label="Next photo"
        :aria-disabled="hasNext ? 'false' : 'true'"
        @click="goNext"
      >&rsaquo;</button>

      <div class="zoom-controls">
        <button type="button" class="zoom-btn" aria-label="Zoom out" @click="zoomBy(-ZOOM_STEP)">&minus;</button>
        <button type="button" class="zoom-btn zoom-reset" aria-label="Reset zoom" @click="reset">Reset</button>
        <button type="button" class="zoom-btn" aria-label="Zoom in" @click="zoomBy(ZOOM_STEP)">+</button>
      </div>

      <button v-if="!inline" type="button" class="zoom-close" aria-label="Close" @click="emitClose">&times;</button>
    </div>
  </Teleport>
</template>

<script setup>
import { ref, computed, watch, nextTick, onBeforeUnmount } from 'vue'
import { swipeStep, trapTabIndex } from '../../lib/photoViewer'

// Reusable fullscreen image viewer with wheel/button/double-click zoom,
// drag-to-pan and touch pinch. Plain CSS transforms only (no deps, no Vant)
// so it is safe in both the Vant driver shell and the shadcn/Tailwind admin
// shell. Caller binds :src and listens for @close — render is guarded inside
// the Teleport so the parent does not need its own v-if.
//
// The fullscreen overlay is a modal dialog: focus moves into it when it opens,
// Tab and Shift+Tab stay inside it, Esc / the X / a click outside the photo
// close it, and focus goes back to whatever had it before (the photo that was
// clicked). A caller showing a set of photos (the chat threads) also binds
// has-prev / has-next / position and listens for @prev / @next: that adds the
// previous and next buttons, the arrow keys and a one-finger swipe at fit size.
const props = defineProps({
  src: { type: String, default: null },
  alt: { type: String, default: 'Image' },
  // Inline mode: render in-place (no Teleport/backdrop/close button) so the
  // image is zoomable/pannable directly inside its container. Default false
  // preserves the existing fullscreen-overlay behavior for every other caller.
  inline: { type: Boolean, default: false },
  hasPrev: { type: Boolean, default: false },
  hasNext: { type: Boolean, default: false },
  // "Photo 2 of 5": shown and announced when it changes.
  position: { type: String, default: '' },
})
const emit = defineEmits(['close', 'prev', 'next'])

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

// Next/previous exist only in the fullscreen overlay, and only for a caller
// that has more than one photo to step through.
const gallery = computed(() => !props.inline && (props.hasPrev || props.hasNext))

const MIN_SCALE = 1
const MAX_SCALE = 5
const ZOOM_STEP = 0.5         // +/- button increment
const WHEEL_FACTOR = 0.0015   // wheel delta -> scale delta
const DBL_SCALE = 2           // double-click "fit to" target

const overlayRef = ref(null)
const imgRef = ref(null)

const scale = ref(1)
const tx = ref(0)
const ty = ref(0)
// Drop the CSS transition while dragging/pinching so the image tracks the
// pointer 1:1; keep it for wheel/button/double-click for a smooth feel.
const isInteracting = ref(false)

// Active pointers, keyed by pointerId, for unified mouse + touch.
// 1 pointer => pan (only when zoomed), 2 pointers => pinch.
const pointers = new Map()
let dragStart = null   // { x, y, tx, ty }
let pinchStart = null  // { dist, scale }
// A one-finger gesture that began at fit size: { id, x, y }. Becomes a
// next/previous swipe on release unless a second finger joined (a pinch).
let swipeStart = null
// The element that had focus when the overlay opened; focus goes back to it
// when the overlay closes.
let opener = null

const imgStyle = computed(() => ({
  transform: `translate(${tx.value}px, ${ty.value}px) scale(${scale.value})`,
}))

function clampScale(v) {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, v))
}

// Keep the image from being dragged entirely off-screen: pan room equals how
// far the scaled image overflows the viewport, plus a little slack so edges
// stay comfortably reachable. clientWidth/Height are the un-transformed
// (layout) dimensions, which the CSS already caps at 90vw/90dvh.
function clampPan() {
  const img = imgRef.value
  if (!img) return
  // Bound the pan to the visible box. `overlayRef` is the inset:0 overlay
  // (≈ viewport) in overlay mode and the host container in inline mode, so its
  // client size is the right reference for both — falls back to the viewport.
  const box = overlayRef.value
  const vw = box ? box.clientWidth : window.innerWidth
  const vh = box ? box.clientHeight : window.innerHeight
  const maxX = Math.max(0, (img.clientWidth * scale.value - vw) / 2) + 60
  const maxY = Math.max(0, (img.clientHeight * scale.value - vh) / 2) + 60
  tx.value = Math.min(maxX, Math.max(-maxX, tx.value))
  ty.value = Math.min(maxY, Math.max(-maxY, ty.value))
}

// Zoom to `target`, keeping the point under (anchorX, anchorY) fixed when an
// anchor is supplied (wheel / double-click / pinch). Buttons pass none, so the
// current translate is preserved. With transform-origin at center, the offset
// of the cursor from the transformed center divided by the current scale is
// the cursor's fixed point in image space; we solve translate to keep it put.
function applyZoom(target, anchorX, anchorY) {
  const next = clampScale(target)
  if (next === scale.value) return
  const img = imgRef.value
  if (img && anchorX != null) {
    const rect = img.getBoundingClientRect()
    const tcx = rect.left + rect.width / 2
    const tcy = rect.top + rect.height / 2
    const dx = (anchorX - tcx) / scale.value
    const dy = (anchorY - tcy) / scale.value
    const layoutCx = tcx - tx.value
    const layoutCy = tcy - ty.value
    tx.value = anchorX - layoutCx - next * dx
    ty.value = anchorY - layoutCy - next * dy
  }
  scale.value = next
  if (scale.value <= MIN_SCALE) { scale.value = MIN_SCALE; tx.value = 0; ty.value = 0 }
  else clampPan()
}

function zoomBy(delta) {
  applyZoom(scale.value + delta)
}

function reset() {
  scale.value = MIN_SCALE
  tx.value = 0
  ty.value = 0
}

function onWheel(e) {
  applyZoom(scale.value - e.deltaY * WHEEL_FACTOR, e.clientX, e.clientY)
}

function onDoubleClick(e) {
  if (scale.value > MIN_SCALE) reset()
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
  imgRef.value?.setPointerCapture?.(e.pointerId)
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
  swipeStart = pointers.size === 1 && scale.value <= MIN_SCALE && gallery.value
    ? { id: e.pointerId, x: e.clientX, y: e.clientY }
    : null
  if (pointers.size === 2) {
    pinchStart = { dist: pointerDistance(), scale: scale.value }
    dragStart = null
    isInteracting.value = true
  } else if (pointers.size === 1 && scale.value > MIN_SCALE) {
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
  imgRef.value?.releasePointerCapture?.(e.pointerId)
  const swipe = swipeStart
  swipeStart = null
  if (swipe && swipe.id === e.pointerId && pointers.size === 0 && e.type !== 'pointercancel' && scale.value <= MIN_SCALE) {
    const step = swipeStep(e.clientX - swipe.x, e.clientY - swipe.y)
    if (step > 0) goNext()
    else if (step < 0) goPrev()
  }
  if (pointers.size < 2) pinchStart = null
  if (pointers.size === 1 && scale.value > MIN_SCALE) {
    // One finger remains after a pinch — re-anchor the drag so it doesn't jump.
    const [p] = [...pointers.values()]
    dragStart = { x: p.x, y: p.y, tx: tx.value, ty: ty.value }
  } else if (pointers.size === 0) {
    dragStart = null
    isInteracting.value = false
  }
}

function emitClose() {
  emit('close')
}

// At either end the button stays (aria-disabled) and does nothing.
function goPrev() {
  if (gallery.value && props.hasPrev) emit('prev')
}
function goNext() {
  if (gallery.value && props.hasNext) emit('next')
}

// Backdrop click closes the fullscreen overlay; inline mode has no backdrop to
// dismiss, so it's a no-op there.
function onBackdropClick() {
  if (!props.inline) emitClose()
}

function trapTab(e) {
  const overlay = overlayRef.value
  if (!overlay || typeof overlay.querySelectorAll !== 'function') return
  const focusable = Array.from(overlay.querySelectorAll(FOCUSABLE_SELECTOR))
  const active = typeof document !== 'undefined' ? document.activeElement : null
  const to = trapTabIndex(focusable.length, focusable.indexOf(active), e.shiftKey)
  if (to < 0) return
  e.preventDefault()
  focusable[to].focus()
}

function onKeydown(e) {
  if (e.key === 'Escape') { e.preventDefault(); emitClose() }
  else if (e.key === 'Tab') trapTab(e)
  else if (e.key === 'ArrowLeft' && gallery.value) { e.preventDefault(); goPrev() }
  else if (e.key === 'ArrowRight' && gallery.value) { e.preventDefault(); goNext() }
}

// Back to the element that opened the overlay, if it is still on the page (a
// conversation switch can have removed the photo that was clicked).
function returnFocus() {
  const el = opener
  opener = null
  if (el && el.isConnected !== false && typeof el.focus === 'function') el.focus()
}

// Reset the view and (un)wire the Esc listener + focus whenever the bound
// image opens, closes, or swaps to a different receipt.
watch(() => props.src, (val, old) => {
  scale.value = MIN_SCALE
  tx.value = 0
  ty.value = 0
  pointers.clear()
  dragStart = null
  pinchStart = null
  swipeStart = null
  isInteracting.value = false
  // Inline mode must NOT hijack Escape (the host modal owns it) or steal focus —
  // only the fullscreen overlay wires those.
  if (val && !props.inline) {
    // Opening (not stepping to the next photo): remember who had focus.
    if (!old) opener = typeof document !== 'undefined' ? document.activeElement : null
    window.addEventListener('keydown', onKeydown)
    nextTick(() => overlayRef.value?.focus())
  } else {
    window.removeEventListener('keydown', onKeydown)
    if (old && !props.inline) returnFocus()
  }
}, { immediate: true })

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  if (props.src && !props.inline) returnFocus()
})
</script>

<style scoped>
.zoom-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.85);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 300;
  overflow: hidden;
  touch-action: none;
  user-select: none;
}
.zoom-img {
  max-width: 90vw;
  max-height: 90vh;
  /* The visible height on a phone with its toolbars showing (90vh is the fallback). */
  max-height: 90dvh;
  border-radius: 8px;
  box-shadow: 0 10px 40px rgba(0, 0, 0, 0.4);
  transform-origin: center center;
  transition: transform 0.15s ease;
  touch-action: none;
  cursor: zoom-in;
  -webkit-user-drag: none;
}
.zoom-img.panning { cursor: grab; }
.zoom-img.panning:active { cursor: grabbing; }
.zoom-img.no-transition { transition: none; }

/* Inline mode — fill the host container (which must be position:relative), no
   fixed overlay chrome. Same zoom/pan engine, just scoped to the box. */
.zoom-inline {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  touch-action: none;
  user-select: none;
  background: transparent;
}
.zoom-inline .zoom-img {
  max-width: 100%;
  max-height: 100%;
  box-shadow: none;
  border-radius: 4px;
}
.zoom-inline .zoom-controls {
  position: absolute;
  bottom: 0.5rem;
  left: 50%;
  transform: translateX(-50%);
}

.zoom-controls {
  position: fixed;
  bottom: max(1.25rem, env(safe-area-inset-bottom, 0px));
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  gap: 0.5rem;
  padding: 0.4rem;
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.55);
  backdrop-filter: blur(4px);
}
.zoom-btn {
  min-width: 2.25rem;
  height: 2.25rem;
  padding: 0 0.75rem;
  border: none;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.12);
  color: #fff;
  font-size: 1.1rem;
  font-weight: 700;
  line-height: 1;
  cursor: pointer;
  font-family: inherit;
  transition: background 0.15s;
}
.zoom-btn:hover { background: rgba(255, 255, 255, 0.28); }
.zoom-reset { font-size: 0.8rem; font-weight: 600; }

.zoom-close {
  position: fixed;
  top: calc(1rem + env(safe-area-inset-top, 0px));
  right: calc(1rem + env(safe-area-inset-right, 0px));
  width: 2.75rem;
  height: 2.75rem;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.12);
  color: #fff;
  font-size: 1.6rem;
  line-height: 1;
  cursor: pointer;
  transition: background 0.15s;
}
.zoom-close:hover { background: rgba(255, 255, 255, 0.28); }
.zoom-close:focus-visible,
.zoom-btn:focus-visible,
.zoom-nav:focus-visible {
  outline: 2px solid #fff;
  outline-offset: 2px;
}

/* Next / previous: 44px targets at the screen's sides, clear of the zoom
   pill and the X. */
.zoom-nav {
  position: fixed;
  top: 50%;
  transform: translateY(-50%);
  width: 2.75rem;
  height: 2.75rem;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
  font-size: 2rem;
  line-height: 1;
  cursor: pointer;
  transition: background 0.15s, opacity 0.15s;
}
.zoom-nav:hover { background: rgba(255, 255, 255, 0.28); }
.zoom-nav[aria-disabled='true'] { opacity: 0.3; cursor: default; }
.zoom-nav[aria-disabled='true']:hover { background: rgba(0, 0, 0, 0.55); }
.zoom-prev { left: max(0.75rem, env(safe-area-inset-left, 0px)); }
.zoom-next { right: max(0.75rem, env(safe-area-inset-right, 0px)); }

.zoom-position {
  position: fixed;
  top: max(1.6rem, env(safe-area-inset-top, 0px));
  left: 50%;
  transform: translateX(-50%);
  margin: 0;
  padding: 0.2rem 0.7rem;
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
  font-size: 0.8rem;
  font-weight: 600;
  pointer-events: none;
}
</style>
