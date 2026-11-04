<template>
  <div class="sig-pad" :class="{ 'sig-pad-off': disabled }">
    <div class="sig-pad-head">
      <span class="sig-pad-label">{{ label }}</span>
      <button v-if="hasDrawn && !disabled" type="button" class="sig-pad-clear" @click="reset">Clear</button>
    </div>
    <!-- pointercancel ends a stroke too: once setPointerCapture holds the pointer,
         pointerleave never fires, and a gesture the browser cancels (a scroll, a
         system swipe, a call) sends pointercancel and nothing else. -->
    <canvas
      ref="canvasRef"
      class="sig-pad-canvas"
      role="img"
      :aria-label="label"
      @pointerdown="startDraw"
      @pointermove="draw"
      @pointerup="endDraw"
      @pointerleave="endDraw"
      @pointercancel="endDraw"
    ></canvas>
    <p v-if="hint" class="sig-pad-hint">{{ hint }}</p>
  </div>
</template>

<script setup>
import { nextTick, onMounted, ref, watch } from 'vue'

// A drawn signature, one per pad. Locked while `disabled` (its consent box unticked,
// or its turn not come). The image leaves only through toDataURL(), as a PNG.
const props = defineProps({
  disabled: { type: Boolean, default: false },
  label: { type: String, default: 'Signature' },
  hint: { type: String, default: '' },
})
const emit = defineEmits(['change'])

const canvasRef = ref(null)
const hasDrawn = ref(false)
// The gate draw() checks; every way a stroke can end, or the pad be wiped, clears it.
let isDrawing = false

function initCanvas() {
  const canvas = canvasRef.value
  if (!canvas) return
  const rect = canvas.getBoundingClientRect()
  canvas.width = Math.round(rect.width)
  canvas.height = Math.round(rect.height) || 160
  const ctx = canvas.getContext('2d')
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  ctx.strokeStyle = '#1a1d27'
  ctx.lineWidth = 2
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
}

// The pointer in canvas pixels, scaled in case the pad was resized since it was set up.
function posOf(e) {
  const canvas = canvasRef.value
  const rect = canvas.getBoundingClientRect()
  const sx = rect.width ? canvas.width / rect.width : 1
  const sy = rect.height ? canvas.height / rect.height : 1
  return { x: (e.clientX - rect.left) * sx, y: (e.clientY - rect.top) * sy }
}

function startDraw(e) {
  if (props.disabled || !canvasRef.value) return
  if (!canvasRef.value.width) initCanvas()
  isDrawing = true
  const ctx = canvasRef.value.getContext('2d')
  const p = posOf(e)
  ctx.beginPath()
  ctx.moveTo(p.x, p.y)
  try { canvasRef.value.setPointerCapture(e.pointerId) } catch { /* pointer already gone */ }
}

function draw(e) {
  if (!isDrawing || props.disabled) return
  const ctx = canvasRef.value.getContext('2d')
  const p = posOf(e)
  ctx.lineTo(p.x, p.y)
  ctx.stroke()
  if (!hasDrawn.value) {
    hasDrawn.value = true
    emit('change', true)
  }
}

function endDraw() { isDrawing = false }

function reset() {
  isDrawing = false
  const had = hasDrawn.value
  hasDrawn.value = false
  initCanvas()
  if (had) emit('change', false)
}

// The signature as a PNG data URI, or null when nothing has been drawn.
function toDataURL() {
  return hasDrawn.value && canvasRef.value ? canvasRef.value.toDataURL('image/png') : null
}

// Locking the pad ends a stroke in progress.
watch(() => props.disabled, (off) => { if (off) isDrawing = false })

onMounted(async () => {
  await nextTick()
  initCanvas()
})

defineExpose({ reset, toDataURL })
</script>

<style scoped>
.sig-pad { display: flex; flex-direction: column; gap: 0.35rem; }
.sig-pad-head { display: flex; align-items: center; justify-content: space-between; min-height: 32px; }
.sig-pad-label { font-size: 0.8rem; font-weight: 600; color: #475569; }
.sig-pad-clear {
  min-height: 32px; padding: 0 0.5rem; font-size: 0.78rem; font-weight: 600; color: #0369a1;
  background: none; border: none; cursor: pointer; font-family: inherit;
}
/* touch-action: none keeps a stroke from scrolling the page under the finger. */
.sig-pad-canvas {
  width: 100%; height: 160px; border: 1px solid #e2e4ea; border-radius: 8px;
  background: #fff; cursor: crosshair; touch-action: none; display: block;
}
.sig-pad-off .sig-pad-canvas { opacity: 0.35; pointer-events: none; }
.sig-pad-hint { margin: 0; font-size: 0.75rem; color: #64748b; }
</style>
