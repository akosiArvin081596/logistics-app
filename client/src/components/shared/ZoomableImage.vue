<template>
  <Teleport to="body">
    <div
      v-if="src"
      ref="overlayRef"
      class="zoom-overlay"
      role="dialog"
      aria-modal="true"
      :aria-label="alt"
      tabindex="-1"
      @click.self="emitClose"
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

      <div class="zoom-controls">
        <button type="button" class="zoom-btn" aria-label="Zoom out" @click="zoomBy(-ZOOM_STEP)">&minus;</button>
        <button type="button" class="zoom-btn zoom-reset" aria-label="Reset zoom" @click="reset">Reset</button>
        <button type="button" class="zoom-btn" aria-label="Zoom in" @click="zoomBy(ZOOM_STEP)">+</button>
      </div>

      <button type="button" class="zoom-close" aria-label="Close" @click="emitClose">&times;</button>
    </div>
  </Teleport>
</template>

<script setup>
import { ref, computed, watch, nextTick, onBeforeUnmount } from 'vue'

// Reusable fullscreen image viewer with wheel/button/double-click zoom,
// drag-to-pan and touch pinch. Plain CSS transforms only (no deps, no Vant)
// so it is safe in both the Vant driver shell and the shadcn/Tailwind admin
// shell. Caller binds :src and listens for @close — render is guarded inside
// the Teleport so the parent does not need its own v-if.
const props = defineProps({
  src: { type: String, default: null },
  alt: { type: String, default: 'Image' },
})
const emit = defineEmits(['close'])

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

const imgStyle = computed(() => ({
  transform: `translate(${tx.value}px, ${ty.value}px) scale(${scale.value})`,
}))

function clampScale(v) {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, v))
}

// Keep the image from being dragged entirely off-screen: pan room equals how
// far the scaled image overflows the viewport, plus a little slack so edges
// stay comfortably reachable. clientWidth/Height are the un-transformed
// (layout) dimensions, which the CSS already caps at 90vw/90vh.
function clampPan() {
  const img = imgRef.value
  if (!img) return
  const maxX = Math.max(0, (img.clientWidth * scale.value - window.innerWidth) / 2) + 60
  const maxY = Math.max(0, (img.clientHeight * scale.value - window.innerHeight) / 2) + 60
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

function onKeydown(e) {
  if (e.key === 'Escape') { e.preventDefault(); emitClose() }
}

// Reset the view and (un)wire the Esc listener + focus whenever the bound
// image opens, closes, or swaps to a different receipt.
watch(() => props.src, (val) => {
  scale.value = MIN_SCALE
  tx.value = 0
  ty.value = 0
  pointers.clear()
  dragStart = null
  pinchStart = null
  isInteracting.value = false
  if (val) {
    window.addEventListener('keydown', onKeydown)
    nextTick(() => overlayRef.value?.focus())
  } else {
    window.removeEventListener('keydown', onKeydown)
  }
}, { immediate: true })

onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))
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

.zoom-controls {
  position: fixed;
  bottom: 1.25rem;
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
  top: 1rem;
  right: 1rem;
  width: 2.5rem;
  height: 2.5rem;
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
</style>
