<template>
  <Teleport to="body">
    <div class="iae-overlay" role="dialog" aria-modal="true" aria-label="Adjust image">
      <div class="iae-header">
        <span>Adjust image</span>
        <button class="iae-x" aria-label="Close" @click="emit('cancel')">&times;</button>
      </div>

      <div ref="stageRef" class="iae-stage">
        <div
          class="iae-canvas-stack"
          :style="{ width: displayW + 'px', height: displayH + 'px' }"
        >
          <canvas ref="viewRef" class="iae-canvas" />
          <!-- Crop rect: the box-shadow dims everything outside it. The box
               itself is non-interactive; only the corner handles drag. -->
          <div class="iae-crop" :style="cropBoxStyle">
            <div class="iae-handle iae-tl" @pointerdown="onHandleDown($event, 'tl')"></div>
            <div class="iae-handle iae-tr" @pointerdown="onHandleDown($event, 'tr')"></div>
            <div class="iae-handle iae-bl" @pointerdown="onHandleDown($event, 'bl')"></div>
            <div class="iae-handle iae-br" @pointerdown="onHandleDown($event, 'br')"></div>
          </div>
        </div>
      </div>

      <div class="iae-tools">
        <div class="iae-row">
          <button class="iae-btn" @click="rotate(-90)">&#8634; Rotate</button>
          <button class="iae-btn" @click="rotate(90)">&#8635; Rotate</button>
          <button class="iae-btn" @click="resetCrop">Reset crop</button>
        </div>
        <label class="iae-slider">
          <span>Straighten {{ fineAngle }}&deg;</span>
          <input type="range" min="-15" max="15" step="0.5" v-model.number="fineAngle" @input="onStraighten" />
        </label>
        <div class="iae-row iae-seg">
          <button :class="['iae-seg-btn', { on: bwMode === 'color' }]" @click="setBw('color')">Color</button>
          <button :class="['iae-seg-btn', { on: bwMode === 'gray' }]" @click="setBw('gray')">Grayscale</button>
          <button :class="['iae-seg-btn', { on: bwMode === 'bw' }]" @click="setBw('bw')">B &amp; W</button>
        </div>
        <label v-if="bwMode === 'bw'" class="iae-slider">
          <span>Threshold</span>
          <input type="range" min="60" max="220" v-model.number="bwCutoff" @input="renderPreview" />
        </label>
        <label class="iae-slider">
          <span>Brightness</span>
          <input type="range" min="50" max="150" v-model.number="brightness" @input="renderPreview" />
        </label>
        <label class="iae-slider">
          <span>Contrast</span>
          <input type="range" min="50" max="150" v-model.number="contrast" @input="renderPreview" />
        </label>
        <div class="iae-row">
          <button class="iae-btn iae-cancel" @click="emit('cancel')">Cancel</button>
          <button class="iae-btn iae-apply" :disabled="processing" @click="apply">
            {{ processing ? 'Applying…' : 'Apply' }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount, nextTick } from 'vue'

const props = defineProps({
  src: { type: String, required: true }, // image data URL to edit
})
const emit = defineEmits(['apply', 'cancel'])

// Cap the working canvas so getImageData / toDataURL stay cheap on phones.
const WORK_MAX = 1600

const stageRef = ref(null)
const viewRef = ref(null)
const displayW = ref(0)
const displayH = ref(0)
const processing = ref(false)

const rotation = ref(0)       // 0 / 90 / 180 / 270 (degrees, clockwise)
const fineAngle = ref(0)      // fine "straighten" angle in degrees (-15..15)
const bwMode = ref('color')   // 'color' | 'gray' | 'bw'
const bwCutoff = ref(150)     // luma threshold for B&W
const brightness = ref(100)   // percent
const contrast = ref(100)     // percent

// Crop edges in WORK (rotated source) pixels.
const cl = ref(0), ct = ref(0), cr = ref(0), cb = ref(0)

// Non-reactive: we don't want Vue proxying canvases/images.
let sourceImg = null
let workCanvas = null   // source scaled to WORK_MAX then rotated
const displayScale = ref(1)  // displayed px / work px (reactive so the crop box rescales)

const cropBoxStyle = computed(() => ({
  left: (cl.value * displayScale.value) + 'px',
  top: (ct.value * displayScale.value) + 'px',
  width: ((cr.value - cl.value) * displayScale.value) + 'px',
  height: ((cb.value - ct.value) * displayScale.value) + 'px',
}))

onMounted(async () => {
  try {
    await loadImage()
  } catch {
    emit('cancel')
    return
  }
  buildWorkCanvas()
  resetCrop()
  await nextTick()
  // rAF: the freshly-teleported full-screen overlay needs a layout pass before
  // we can measure the stage and size/draw the canvas.
  requestAnimationFrame(() => { layout(); renderPreview() })
  window.addEventListener('resize', onResize)
})

onBeforeUnmount(() => window.removeEventListener('resize', onResize))

function onResize() { layout(); renderPreview() }

function loadImage() {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => { sourceImg = img; resolve() }
    img.onerror = () => reject(new Error('load_failed'))
    img.src = props.src
  })
}

// workCanvas = source downscaled to WORK_MAX, then rotated by `rotation`.
function buildWorkCanvas() {
  const sw = sourceImg.naturalWidth || sourceImg.width
  const sh = sourceImg.naturalHeight || sourceImg.height
  const long = Math.max(sw, sh)
  const scale = long > WORK_MAX ? WORK_MAX / long : 1
  const bw = Math.max(1, Math.round(sw * scale))
  const bh = Math.max(1, Math.round(sh * scale))
  const base = document.createElement('canvas')
  base.width = bw; base.height = bh
  base.getContext('2d').drawImage(sourceImg, 0, 0, bw, bh)

  // Total rotation = the 90° steps + the fine "straighten" angle. Size the
  // canvas to the rotated bounding box and fill it white so the triangular
  // corners exposed by straightening blend into a paper document.
  const rad = (((rotation.value + fineAngle.value) % 360) * Math.PI) / 180
  const cos = Math.abs(Math.cos(rad)), sin = Math.abs(Math.sin(rad))
  const cw = Math.max(1, Math.ceil(bw * cos + bh * sin))
  const ch = Math.max(1, Math.ceil(bw * sin + bh * cos))
  const c = document.createElement('canvas')
  c.width = cw; c.height = ch
  const ctx = c.getContext('2d')
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, cw, ch)
  ctx.save()
  ctx.translate(cw / 2, ch / 2)
  ctx.rotate(rad)
  ctx.drawImage(base, -bw / 2, -bh / 2)
  ctx.restore()
  workCanvas = c
}

function resetCrop() {
  cl.value = 0; ct.value = 0
  cr.value = workCanvas.width; cb.value = workCanvas.height
}

function rotate(deg) {
  rotation.value = (((rotation.value + deg) % 360) + 360) % 360
  buildWorkCanvas()
  resetCrop()
  layout()
  renderPreview()
}

// Live "straighten" — rebuild the rotated work canvas, throttled to one rebuild
// per animation frame so dragging the slider stays smooth.
let straightenRaf = 0
function onStraighten() {
  if (straightenRaf) return
  straightenRaf = requestAnimationFrame(() => {
    straightenRaf = 0
    buildWorkCanvas()
    resetCrop()
    layout()
    renderPreview()
  })
}

function setBw(mode) { bwMode.value = mode; renderPreview() }

// Size the on-screen canvas to fit the stage while preserving aspect.
function layout() {
  const stage = stageRef.value
  if (!stage || !workCanvas) return
  const maxW = stage.clientWidth, maxH = stage.clientHeight
  if (!maxW || !maxH) return
  const scale = Math.min(maxW / workCanvas.width, maxH / workCanvas.height, 1)
  displayScale.value = scale
  displayW.value = Math.round(workCanvas.width * scale)
  displayH.value = Math.round(workCanvas.height * scale)
  const v = viewRef.value
  if (v) { v.width = displayW.value; v.height = displayH.value }
}

// Draw the preview at display size with brightness/contrast + optional B&W.
function renderPreview() {
  const v = viewRef.value
  if (!v || !workCanvas || !v.width) return
  const ctx = v.getContext('2d')
  ctx.clearRect(0, 0, v.width, v.height)
  ctx.filter = `brightness(${brightness.value / 100}) contrast(${contrast.value / 100})`
  ctx.drawImage(workCanvas, 0, 0, v.width, v.height)
  ctx.filter = 'none'
  if (bwMode.value !== 'color') applyBw(ctx, v.width, v.height)
}

// Grayscale or threshold via Rec. 709 luma (ported from the old jscanify
// scanner's thresholdToBW — black text on white paper comes out crisper).
function applyBw(ctx, w, h) {
  const id = ctx.getImageData(0, 0, w, h)
  const d = id.data
  const threshold = bwMode.value === 'bw'
  const cut = bwCutoff.value
  for (let i = 0; i < d.length; i += 4) {
    const y = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]
    const val = threshold ? (y >= cut ? 255 : 0) : y
    d[i] = val; d[i + 1] = val; d[i + 2] = val
  }
  ctx.putImageData(id, 0, 0)
}

// Drag a crop corner; the opposite edges stay fixed. Pointer capture + clamp
// pattern ported from the old corner-drag scanner code.
function onHandleDown(e, corner) {
  e.preventDefault(); e.stopPropagation()
  const canvas = viewRef.value
  if (!canvas) return
  const rect = canvas.getBoundingClientRect()
  const target = e.currentTarget
  try { target.setPointerCapture(e.pointerId) } catch { /* old browsers */ }
  const MIN = 24 // minimum crop size in work px

  const move = (ev) => {
    const x = Math.max(0, Math.min(workCanvas.width, (ev.clientX - rect.left) / displayScale.value))
    const y = Math.max(0, Math.min(workCanvas.height, (ev.clientY - rect.top) / displayScale.value))
    if (corner === 'tl') { cl.value = Math.min(x, cr.value - MIN); ct.value = Math.min(y, cb.value - MIN) }
    else if (corner === 'tr') { cr.value = Math.max(x, cl.value + MIN); ct.value = Math.min(y, cb.value - MIN) }
    else if (corner === 'bl') { cl.value = Math.min(x, cr.value - MIN); cb.value = Math.max(y, ct.value + MIN) }
    else if (corner === 'br') { cr.value = Math.max(x, cl.value + MIN); cb.value = Math.max(y, ct.value + MIN) }
  }
  const up = () => {
    target.removeEventListener('pointermove', move)
    target.removeEventListener('pointerup', up)
    target.removeEventListener('pointercancel', up)
    try { target.releasePointerCapture(e.pointerId) } catch { /* ignore */ }
  }
  target.addEventListener('pointermove', move)
  target.addEventListener('pointerup', up)
  target.addEventListener('pointercancel', up)
}

// Render the final cropped + filtered image at working resolution and emit it.
function apply() {
  if (processing.value || !workCanvas) return
  processing.value = true
  try {
    const sx = Math.round(cl.value), sy = Math.round(ct.value)
    const sw = Math.max(1, Math.round(cr.value - cl.value))
    const sh = Math.max(1, Math.round(cb.value - ct.value))
    const out = document.createElement('canvas')
    out.width = sw; out.height = sh
    const ctx = out.getContext('2d')
    ctx.filter = `brightness(${brightness.value / 100}) contrast(${contrast.value / 100})`
    ctx.drawImage(workCanvas, sx, sy, sw, sh, 0, 0, sw, sh)
    ctx.filter = 'none'
    if (bwMode.value !== 'color') applyBw(ctx, sw, sh)
    emit('apply', out.toDataURL('image/jpeg', 0.9))
  } catch {
    processing.value = false
  }
}
</script>

<style scoped>
.iae-overlay {
  position: fixed;
  inset: 0;
  background: #000;
  z-index: 10001;
  display: flex;
  flex-direction: column;
  color: #fff;
  font-family: inherit;
}
.iae-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.75rem 1rem;
  background: rgba(0, 0, 0, 0.85);
  font-size: 0.95rem;
  flex-shrink: 0;
}
.iae-x {
  background: transparent;
  border: none;
  color: #fff;
  font-size: 1.6rem;
  line-height: 1;
  cursor: pointer;
  padding: 0 0.25rem;
}
.iae-stage {
  flex: 1;
  min-height: 0;
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  touch-action: none;
  padding: 0.5rem;
}
.iae-canvas-stack { position: relative; touch-action: none; }
.iae-canvas { display: block; width: 100%; height: 100%; }
.iae-crop {
  position: absolute;
  border: 1px solid rgba(255, 255, 255, 0.9);
  box-shadow: 0 0 0 9999px rgba(0, 0, 0, 0.55);
  pointer-events: none;
  box-sizing: border-box;
}
.iae-handle {
  position: absolute;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: rgba(74, 144, 226, 0.5);
  border: 2px solid #fff;
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.4);
  pointer-events: auto;
  touch-action: none;
  cursor: grab;
}
.iae-tl { left: 0; top: 0; transform: translate(-50%, -50%); }
.iae-tr { right: 0; top: 0; transform: translate(50%, -50%); }
.iae-bl { left: 0; bottom: 0; transform: translate(-50%, 50%); }
.iae-br { right: 0; bottom: 0; transform: translate(50%, 50%); }
.iae-tools {
  background: rgba(0, 0, 0, 0.9);
  padding: 0.6rem 0.75rem;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.iae-row { display: flex; gap: 0.5rem; }
.iae-btn {
  flex: 1;
  padding: 0.6rem 0.5rem;
  border-radius: 8px;
  border: none;
  background: #333;
  color: #fff;
  font-size: 0.85rem;
  font-weight: 600;
  font-family: inherit;
  cursor: pointer;
}
.iae-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.iae-apply { background: #4a90e2; }
.iae-cancel { background: #555; }
.iae-seg { gap: 0; border-radius: 8px; overflow: hidden; }
.iae-seg-btn {
  flex: 1;
  padding: 0.55rem 0.4rem;
  border: none;
  background: #2a2a2a;
  color: #bbb;
  font-size: 0.8rem;
  font-weight: 600;
  font-family: inherit;
  cursor: pointer;
}
.iae-seg-btn.on { background: #4a90e2; color: #fff; }
.iae-slider {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  font-size: 0.78rem;
  color: #ddd;
}
.iae-slider span { width: 84px; flex-shrink: 0; }
.iae-slider input { flex: 1; }
</style>
