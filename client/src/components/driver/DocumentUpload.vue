<template>
  <div class="card doc-upload">
    <div class="doc-header">{{ headerText }}</div>
    <p class="doc-hint">{{ hintText }}</p>

    <!-- Document type selector -->
    <select
      v-if="showTypeSelector"
      v-model="selectedType"
      class="type-select"
    >
      <option v-for="t in docTypes" :key="t.value" :value="t.value">{{ t.label }}</option>
    </select>

    <!-- File thumbnails -->
    <div v-if="files.length" class="photo-grid">
      <div v-for="(f, i) in files" :key="i" class="photo-thumb">
        <img v-if="f.isImage" :src="f.data" alt="Photo" />
        <div v-else class="doc-icon">
          <span class="doc-icon-emoji">&#128196;</span>
          <span class="doc-icon-name">{{ f.name }}</span>
        </div>
        <button class="thumb-remove" @click="removeFile(i)">&times;</button>
        <span class="thumb-num">{{ i + 1 }}</span>
      </div>
      <!-- + Add another page: scan-driven for POD/BOL, gallery picker otherwise -->
      <button
        v-if="isScanDocType"
        type="button"
        class="photo-add"
        :disabled="scannerLoading"
        title="Scan another page"
        @click="startScan"
      >
        <span>+</span>
      </button>
      <label v-else class="photo-add">
        <input
          ref="addInput"
          type="file"
          accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.csv,.txt"
          hidden
          @change="handleFile"
        />
        <span>+</span>
      </label>
    </div>

    <!-- Initial capture/upload button -->
    <div v-else class="upload-buttons">
      <!-- POD/BOL: Scan replaces Take Photo (brokers reject raw camera shots) -->
      <button
        v-if="isScanDocType"
        type="button"
        class="photo-btn scan-btn"
        :disabled="scannerLoading"
        @click="startScan"
      >
        <span v-if="!scannerLoading">&#128196; Scan Document</span>
        <span v-else>Loading scanner&hellip;</span>
      </button>
      <label v-else class="photo-btn">
        <input
          ref="cameraInput"
          type="file"
          accept="image/*"
          capture="camera"
          hidden
          @change="handleFile"
        />
        <span>&#128247; Take Photo</span>
      </label>
      <label class="photo-btn">
        <input
          ref="fileInput"
          type="file"
          accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.csv,.txt"
          hidden
          @change="handleFile"
        />
        <span>&#128196; Upload File</span>
      </label>
    </div>

    <!-- Hidden input used by Scan flow (clicked programmatically after the
         jscanify/OpenCV bundle is loaded, so we can show a spinner first). -->
    <input
      ref="scanInput"
      type="file"
      accept="image/*"
      capture="environment"
      hidden
      @change="handleScanFile"
    />

    <button
      class="btn btn-primary"
      :disabled="files.length === 0 || uploading"
      @click="handleUpload"
    >
      {{ uploading ? 'Uploading...' : `Upload ${selectedType} (${files.length} file${files.length !== 1 ? 's' : ''})` }}
    </button>

    <!-- Scanner overlay (full-screen). Teleported to body so the styles in the
         second un-scoped <style> block apply and so nested overflow/transform
         ancestors can't clip the modal. -->
    <Teleport to="body">
      <div
        v-if="scannerOpen"
        class="scanner-overlay"
        role="dialog"
        aria-modal="true"
        aria-label="Adjust scan corners"
      >
        <div class="scanner-header">
          <span>Drag the corners to match the page</span>
          <button class="scanner-close" aria-label="Close scanner" @click="cancelScan">&times;</button>
        </div>
        <div ref="canvasWrapRef" class="scanner-canvas-wrap">
          <!-- Single stack so canvas + SVG + corner handles all share one
               coordinate origin (the canvas's top-left), regardless of how
               the wrap centers it. -->
          <div
            v-if="displayW && displayH"
            class="scanner-canvas-stack"
            :style="{ width: displayW + 'px', height: displayH + 'px' }"
          >
            <canvas ref="scanCanvasRef" class="scanner-canvas" />
            <svg
              class="scanner-quad"
              :viewBox="`0 0 ${displayW} ${displayH}`"
              preserveAspectRatio="none"
            >
              <polygon :points="quadPoints" />
            </svg>
            <div
              v-for="(c, i) in corners"
              :key="i"
              class="scanner-corner"
              :style="{ left: c.displayX + 'px', top: c.displayY + 'px' }"
              @pointerdown="onCornerDown($event, i)"
            />
          </div>
        </div>
        <div class="scanner-actions">
          <button class="scanner-btn scanner-btn-secondary" :disabled="processing" @click="cancelScan">Cancel</button>
          <button class="scanner-btn scanner-btn-secondary" :disabled="processing" @click="retake">Retake</button>
          <button class="scanner-btn scanner-btn-primary" :disabled="processing" @click="applyScan">
            {{ processing ? 'Processing&hellip;' : 'Apply Scan' }}
          </button>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script setup>
import { ref, computed, watch, nextTick, onBeforeUnmount } from 'vue'
import { useApi } from '../../composables/useApi'
import { useToast } from '../../composables/useToast'

const props = defineProps({
  loadId: { type: String, required: true },
  driverName: { type: String, required: true },
  rowIndex: { type: Number, required: true },
  docType: { type: String, default: null },
  showTypeSelector: { type: Boolean, default: true },
})

const emit = defineEmits(['uploaded'])

const api = useApi()
const toast = useToast()

const docTypes = [
  { value: 'POD', label: 'Proof of Delivery' },
  { value: 'Receipt', label: 'Receipt' },
  { value: 'BOL', label: 'Bill of Lading' },
  { value: 'Other', label: 'Other Document' },
]

const selectedType = ref(props.docType || 'POD')
const cameraInput = ref(null)
const fileInput = ref(null)
const addInput = ref(null)
const files = ref([]) // { data: base64, name: string, type: string, isImage: boolean }
const uploading = ref(false)

// --- Scanner state (jscanify + OpenCV.js, lazy-loaded on first Scan tap) ---
const scanInput = ref(null)
const canvasWrapRef = ref(null)
const scanCanvasRef = ref(null)
const scannerOpen = ref(false)
const scannerLoading = ref(false)
const processing = ref(false)
const corners = ref([])      // [{x, y, displayX, displayY}] — x/y in source pixels
const displayW = ref(0)
const displayH = ref(0)

// non-reactive references — we don't want Vue proxying the OpenCV instance
let sourceImage = null       // HTMLImageElement of the captured photo
let sourceBlobUrl = ''       // blob: URL for sourceImage.src — must be revoked
let displayScale = 1         // canvas-displayed / source-pixel
let jscanifyInstance = null  // cached so multi-page scans don't re-construct

const isScanDocType = computed(() =>
  selectedType.value === 'POD' || selectedType.value === 'BOL'
)

watch(() => props.docType, (val) => {
  if (val) selectedType.value = val
})

onBeforeUnmount(() => {
  // Defensive — if the user navigates away mid-scan, free the blob URL
  if (sourceBlobUrl) {
    URL.revokeObjectURL(sourceBlobUrl)
    sourceBlobUrl = ''
  }
})

const headerText = computed(() => {
  const labels = { POD: 'Upload Proof of Delivery', Receipt: 'Upload Receipt', BOL: 'Upload Bill of Lading', Other: 'Upload Document' }
  return labels[selectedType.value] || 'Upload Document'
})

const hintText = computed(() => {
  if (selectedType.value === 'Receipt') return `Take photos of the receipt for Load ${props.loadId}`
  return `Take photos or upload files for Load ${props.loadId}`
})

async function compressImage(file) {
  const MAX = 1200
  // Decode + downscale via createImageBitmap. The previous Image+Canvas path
  // materialised a 12MP photo as ~48MB of raw RGBA before drawing, which
  // OOM-killed the tab on low-RAM phones (same fix already applied to the
  // ExpenseForm receipt path in commit 59fcd80).
  try {
    const probe = await createImageBitmap(file)
    let w = probe.width
    let h = probe.height
    probe.close()
    if (w > MAX || h > MAX) {
      if (w > h) { h = Math.round((h * MAX) / w); w = MAX }
      else { w = Math.round((w * MAX) / h); h = MAX }
    }
    const bitmap = await createImageBitmap(file, {
      resizeWidth: w,
      resizeHeight: h,
      resizeQuality: 'medium',
    })
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    canvas.getContext('2d').drawImage(bitmap, 0, 0)
    bitmap.close()
    const dataUrl = canvas.toDataURL('image/jpeg', 0.8)
    canvas.width = 0
    canvas.height = 0
    return dataUrl
  } catch {
    // Unsupported format (HEIC on older browsers, etc.) — fall back to the
    // raw file so the upload can still proceed without compression.
    return await readFileAsDataURL(file)
  }
}

function readFileAsDataURL(file) {
  return new Promise((resolve) => {
    const reader = new FileReader()
    reader.onload = (e) => resolve(e.target.result)
    reader.readAsDataURL(file)
  })
}

async function handleFile(event) {
  const file = event.target.files[0]
  if (!file) return

  if (file.type.startsWith('image/')) {
    const data = await compressImage(file)
    files.value.push({ data, name: file.name, type: file.type, isImage: true })
  } else {
    const data = await readFileAsDataURL(file)
    files.value.push({ data, name: file.name, type: file.type, isImage: false })
  }
  event.target.value = ''
}

function removeFile(index) {
  files.value.splice(index, 1)
}

// ============================================================
// Scanner: lazy-loaded jscanify + OpenCV.js
// ============================================================
// Module-scope caches: the wasm-bearing opencv.js is heavy (~9MB) — loading it
// once and keeping the cv/jscanify references alive across component
// remounts means the driver only pays the cost on the first POD/BOL of the
// session. The downloaded script is also browser-cached by URL.
const SCAN_PRE_DOWNSCALE = 2000   // px — clip source before cv.imread() to avoid
                                  // OOM on older iPhones (12MP photos → ~50MB Mat)
const SCAN_OUTPUT_MAX = 1200      // px — final long edge (matches compressImage)
const SCAN_BW_CUTOFF = 150        // luma threshold; paper photos read dim, so 150
                                  // gives more black ink than the naive 127

let openCVPromise = null

function loadOpenCV() {
  if (typeof window === 'undefined') return Promise.reject(new Error('no_window'))
  if (window.cv && window.cv.Mat) return Promise.resolve(window.cv)
  if (openCVPromise) return openCVPromise
  openCVPromise = new Promise((resolve, reject) => {
    // The opencv.js we ship from /vendor/opencv/ has its WASM embedded as a
    // base64 data URL, so no locateFile shim is needed — it boots from the
    // single JS file alone. Module.onRuntimeInitialized must be set BEFORE the
    // script runs (the Emscripten loader reads window.Module on init).
    window.Module = window.Module || {}
    const prev = window.Module.onRuntimeInitialized
    window.Module.onRuntimeInitialized = () => {
      if (typeof prev === 'function') {
        try { prev() } catch { /* ignore upstream handler errors */ }
      }
      resolve(window.cv)
    }
    const s = document.createElement('script')
    s.src = '/vendor/opencv/opencv.js'
    s.async = true
    s.onerror = () => {
      openCVPromise = null
      reject(new Error('opencv_load_failed'))
    }
    document.head.appendChild(s)
  })
  return openCVPromise
}

async function loadJscanify() {
  if (jscanifyInstance) return jscanifyInstance
  const [mod] = await Promise.all([
    import('jscanify/client'),
    loadOpenCV(),
  ])
  const Ctor = (mod && (mod.default || mod)) || window.jscanify
  if (typeof Ctor !== 'function') throw new Error('jscanify_load_failed')
  jscanifyInstance = new Ctor()
  return jscanifyInstance
}

async function startScan() {
  if (scannerLoading.value || scannerOpen.value) return
  scannerLoading.value = true
  try {
    await loadJscanify()
  } catch (err) {
    scannerLoading.value = false
    toast.show('Scanner unavailable, using photo instead', 'error')
    // Fallback path: the legacy Take Photo input only renders for non-POD
    // types, so for POD/BOL we use the same hidden scan input but skip the
    // scanner overlay — the file lands in files[] via the handleFile path.
    triggerLegacyPhotoFallback()
    return
  }
  scannerLoading.value = false
  scanInput.value?.click()
}

function triggerLegacyPhotoFallback() {
  // Build a one-shot listener that routes the next scan-input change through
  // the regular handleFile() so the user still gets *something* on the load.
  const input = scanInput.value
  if (!input) return
  const onceHandler = async (ev) => {
    input.removeEventListener('change', onceHandler)
    input.addEventListener('change', handleScanFile)
    await handleFile(ev)
  }
  input.removeEventListener('change', handleScanFile)
  input.addEventListener('change', onceHandler, { once: true })
  input.click()
}

async function handleScanFile(event) {
  const file = event.target.files && event.target.files[0]
  event.target.value = ''
  if (!file) return
  try {
    const img = await fileToImage(file, SCAN_PRE_DOWNSCALE)
    sourceImage = img
    scannerOpen.value = true
    await nextTick()
    layoutCanvas(img)
    autoDetectCorners(img)
  } catch {
    toast.show('Could not load the captured image. Please try again.', 'error')
    closeScanner()
  }
}

// Decode a File to an HTMLImageElement. We downscale via createImageBitmap if
// the long edge exceeds `maxEdge` so OpenCV's cv.imread doesn't materialise a
// 50MB Mat from a 12MP photo (same trick `compressImage` uses).
async function fileToImage(file, maxEdge) {
  let blob = file
  try {
    const probe = await createImageBitmap(file)
    const long = Math.max(probe.width, probe.height)
    if (long > maxEdge) {
      const scale = maxEdge / long
      const w = Math.round(probe.width * scale)
      const h = Math.round(probe.height * scale)
      const bitmap = await createImageBitmap(file, {
        resizeWidth: w,
        resizeHeight: h,
        resizeQuality: 'medium',
      })
      const canvas = document.createElement('canvas')
      canvas.width = w
      canvas.height = h
      canvas.getContext('2d').drawImage(bitmap, 0, 0)
      bitmap.close()
      probe.close()
      blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', 0.92))
      canvas.width = 0
      canvas.height = 0
    } else {
      probe.close()
    }
  } catch {
    // Browsers without createImageBitmap (or HEIC blobs) — pass the raw file
    // through. cv.imread will still work on the resulting <img>, just slower.
  }
  return await new Promise((resolve, reject) => {
    if (sourceBlobUrl) URL.revokeObjectURL(sourceBlobUrl)
    sourceBlobUrl = URL.createObjectURL(blob)
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('decode_failed'))
    img.src = sourceBlobUrl
  })
}

function layoutCanvas(img) {
  const wrap = canvasWrapRef.value
  if (!wrap) return
  const maxW = wrap.clientWidth
  const maxH = wrap.clientHeight
  if (!maxW || !maxH) return
  const scale = Math.min(maxW / img.width, maxH / img.height, 1)
  displayScale = scale
  displayW.value = Math.round(img.width * scale)
  displayH.value = Math.round(img.height * scale)
  const cnv = scanCanvasRef.value
  if (!cnv) return
  cnv.width = displayW.value
  cnv.height = displayH.value
  cnv.getContext('2d').drawImage(img, 0, 0, displayW.value, displayH.value)
}

function autoDetectCorners(img) {
  const cv = window.cv
  let src = null
  let contour = null
  try {
    src = cv.imread(img)
    contour = jscanifyInstance.findPaperContour(src)
    if (contour) {
      const cp = jscanifyInstance.getCornerPoints(contour, src)
      if (cp.topLeftCorner && cp.topRightCorner && cp.bottomRightCorner && cp.bottomLeftCorner) {
        corners.value = [
          toCorner(cp.topLeftCorner),
          toCorner(cp.topRightCorner),
          toCorner(cp.bottomRightCorner),
          toCorner(cp.bottomLeftCorner),
        ]
        return
      }
    }
    corners.value = defaultCorners(img.width, img.height)
  } catch {
    corners.value = defaultCorners(img.width, img.height)
  } finally {
    if (contour && typeof contour.delete === 'function') contour.delete()
    if (src && typeof src.delete === 'function') src.delete()
  }
}

function toCorner(pt) {
  return {
    x: pt.x,
    y: pt.y,
    displayX: pt.x * displayScale,
    displayY: pt.y * displayScale,
  }
}

function defaultCorners(w, h) {
  const m = 0.1
  return [
    toCorner({ x: w * m,        y: h * m }),
    toCorner({ x: w * (1 - m),  y: h * m }),
    toCorner({ x: w * (1 - m),  y: h * (1 - m) }),
    toCorner({ x: w * m,        y: h * (1 - m) }),
  ]
}

function onCornerDown(e, idx) {
  e.preventDefault()
  const canvas = scanCanvasRef.value
  if (!canvas) return
  // Corners are positioned relative to the canvas's top-left (they live inside
  // the .scanner-canvas-stack div which is exactly the canvas's size), so we
  // measure pointer position against the canvas rect directly.
  const canvasRect = canvas.getBoundingClientRect()
  const target = e.currentTarget
  try { target.setPointerCapture(e.pointerId) } catch { /* old browsers */ }

  const move = (ev) => {
    const dx = ev.clientX - canvasRect.left
    const dy = ev.clientY - canvasRect.top
    const clampedX = Math.max(0, Math.min(displayW.value, dx))
    const clampedY = Math.max(0, Math.min(displayH.value, dy))
    const c = corners.value[idx]
    if (!c) return
    c.displayX = clampedX
    c.displayY = clampedY
    c.x = clampedX / displayScale
    c.y = clampedY / displayScale
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

const quadPoints = computed(() => {
  if (!corners.value.length) return ''
  return corners.value.map(c => `${c.displayX},${c.displayY}`).join(' ')
})

async function applyScan() {
  if (processing.value || !sourceImage) return
  processing.value = true
  try {
    const [tl, tr, br, bl] = corners.value
    if (!tl || !tr || !br || !bl) throw new Error('missing_corners')
    // Compute output dimensions from the quad — preserves the actual paper's
    // aspect, not the photo's
    const wTop = Math.hypot(tr.x - tl.x, tr.y - tl.y)
    const wBot = Math.hypot(br.x - bl.x, br.y - bl.y)
    const hLeft = Math.hypot(bl.x - tl.x, bl.y - tl.y)
    const hRight = Math.hypot(br.x - tr.x, br.y - tr.y)
    let outW = Math.round(Math.max(wTop, wBot))
    let outH = Math.round(Math.max(hLeft, hRight))
    if (!outW || !outH) throw new Error('zero_dim')
    if (outW > SCAN_OUTPUT_MAX || outH > SCAN_OUTPUT_MAX) {
      const r = outW > outH ? SCAN_OUTPUT_MAX / outW : SCAN_OUTPUT_MAX / outH
      outW = Math.round(outW * r)
      outH = Math.round(outH * r)
    }
    const warped = jscanifyInstance.extractPaper(sourceImage, outW, outH, {
      topLeftCorner:     { x: tl.x, y: tl.y },
      topRightCorner:    { x: tr.x, y: tr.y },
      bottomRightCorner: { x: br.x, y: br.y },
      bottomLeftCorner:  { x: bl.x, y: bl.y },
    })
    if (!warped) throw new Error('extract_failed')
    const bw = thresholdToBW(warped, SCAN_BW_CUTOFF)
    const dataUrl = bw.toDataURL('image/jpeg', 0.85)
    files.value.push({
      data: dataUrl,
      name: `scan-${Date.now()}.jpg`,
      type: 'image/jpeg',
      isImage: true,
    })
    closeScanner()
  } catch {
    toast.show('Could not process scan. Adjust the corners and try again.', 'error')
    processing.value = false
  }
}

// Canvas2D grayscale + threshold. Rec. 709 luma is closer to perceived brightness
// than a naïve (R+G+B)/3 — black text on white paper comes out crisper.
function thresholdToBW(srcCanvas, cutoff) {
  const w = srcCanvas.width
  const h = srcCanvas.height
  const out = document.createElement('canvas')
  out.width = w
  out.height = h
  const ctx = out.getContext('2d')
  ctx.drawImage(srcCanvas, 0, 0)
  const id = ctx.getImageData(0, 0, w, h)
  const d = id.data
  for (let i = 0; i < d.length; i += 4) {
    const y = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]
    const v = y >= cutoff ? 255 : 0
    d[i] = v
    d[i + 1] = v
    d[i + 2] = v
  }
  ctx.putImageData(id, 0, 0)
  return out
}

function retake() {
  if (processing.value) return
  closeScanner()
  // Re-open the camera. We don't await loadJscanify again — it's cached.
  scanInput.value?.click()
}

function cancelScan() {
  if (processing.value) return
  closeScanner()
}

function closeScanner() {
  scannerOpen.value = false
  processing.value = false
  corners.value = []
  displayW.value = 0
  displayH.value = 0
  sourceImage = null
  if (sourceBlobUrl) {
    URL.revokeObjectURL(sourceBlobUrl)
    sourceBlobUrl = ''
  }
}

async function handleUpload() {
  if (files.value.length === 0 || uploading.value) return
  uploading.value = true
  try {
    const images = files.value.filter(f => f.isImage)
    const docs = files.value.filter(f => !f.isImage)

    // Upload images as before (converted to multi-page PDF server-side)
    if (images.length > 0) {
      const photoData = images.length === 1 ? images[0].data : images.map(f => f.data)
      await api.post('/api/documents/upload', {
        loadId: props.loadId,
        rowIndex: props.rowIndex,
        docType: selectedType.value,
        photoData,
        driverName: props.driverName,
        fileType: 'image',
      })
    }

    // Upload each document file separately
    for (const doc of docs) {
      await api.post('/api/documents/upload', {
        loadId: props.loadId,
        rowIndex: props.rowIndex,
        docType: selectedType.value,
        photoData: doc.data,
        driverName: props.driverName,
        fileType: 'document',
        fileName: doc.name,
      })
    }

    const total = files.value.length
    toast.show(`${selectedType.value} uploaded (${total} file${total !== 1 ? 's' : ''})`)
    emit('uploaded', { type: selectedType.value })
    files.value = []
  } catch (err) {
    toast.show(err.message || 'Failed to upload document', 'error')
  } finally {
    uploading.value = false
  }
}
</script>

<style scoped>
.doc-upload { margin-top: 1rem; }

.doc-header {
  font-weight: 600;
  font-size: 0.95rem;
  margin-bottom: 0.25rem;
}

.doc-hint {
  font-size: 0.82rem;
  color: var(--text-dim);
  margin-bottom: 0.75rem;
}

.type-select {
  width: 100%;
  padding: 0.5rem 0.65rem;
  border: 1px solid var(--border);
  border-radius: 6px;
  font-family: inherit;
  font-size: 0.85rem;
  background: var(--surface);
  color: var(--text);
  margin-bottom: 0.75rem;
  cursor: pointer;
}

.upload-buttons {
  display: flex;
  gap: 0.5rem;
  margin-bottom: 0.75rem;
}

.photo-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 1;
  min-height: 80px;
  border: 2px dashed var(--border);
  border-radius: var(--radius);
  cursor: pointer;
  font-size: 0.85rem;
  color: var(--text-dim);
  transition: border-color 0.15s;
}

.photo-btn:hover { border-color: var(--accent); }
/* Scan button is the recommended path for POD/BOL — give it a tinted box so
   drivers don't habit-tap Take Photo (which is hidden for these doc types
   anyway, but the visual signal still helps when they re-open the upload). */
.photo-btn.scan-btn {
  background: transparent;
  font-family: inherit;
  color: var(--accent);
  border-color: var(--accent);
  font-weight: 600;
}
.photo-btn.scan-btn:disabled {
  opacity: 0.6;
  cursor: progress;
}

/* Scan-driven "+" button (POD/BOL) — same visual as the gallery + label but
   it's a <button>, so we re-declare the box styles. */
button.photo-add {
  width: 72px;
  height: 72px;
  border: 2px dashed var(--border);
  background: transparent;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  font-size: 1.5rem;
  color: var(--text-dim);
  font-family: inherit;
  transition: border-color 0.15s;
  padding: 0;
}
button.photo-add:hover {
  border-color: var(--accent);
  color: var(--accent);
}
button.photo-add:disabled {
  opacity: 0.6;
  cursor: progress;
}

/* Photo/file grid */
.photo-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin-bottom: 0.75rem;
}
.photo-thumb {
  position: relative;
  width: 72px;
  height: 72px;
  border-radius: 8px;
  overflow: hidden;
  border: 1px solid var(--border);
}
.photo-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.doc-icon {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  background: var(--bg);
  padding: 0.2rem;
}
.doc-icon-emoji {
  font-size: 1.5rem;
  line-height: 1;
}
.doc-icon-name {
  font-size: 0.5rem;
  color: var(--text-dim);
  text-align: center;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  width: 100%;
  margin-top: 0.15rem;
}
.thumb-remove {
  position: absolute;
  top: 2px;
  right: 2px;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: rgba(0,0,0,0.6);
  color: #fff;
  border: none;
  font-size: 0.75rem;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  line-height: 1;
}
.thumb-num {
  position: absolute;
  bottom: 2px;
  left: 2px;
  background: rgba(0,0,0,0.5);
  color: #fff;
  font-size: 0.6rem;
  font-weight: 700;
  padding: 0.05rem 0.3rem;
  border-radius: 4px;
}
.photo-add {
  width: 72px;
  height: 72px;
  border: 2px dashed var(--border);
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  font-size: 1.5rem;
  color: var(--text-dim);
  transition: border-color 0.15s;
}
.photo-add:hover {
  border-color: var(--accent);
  color: var(--accent);
}

.btn-primary {
  width: 100%;
  padding: 0.7rem;
  background: var(--accent);
  color: #fff;
  border: none;
  border-radius: var(--radius);
  font-family: inherit;
  font-size: 0.9rem;
  font-weight: 600;
  cursor: pointer;
  transition: opacity 0.15s;
}

.btn-primary:hover { opacity: 0.9; }
.btn-primary:disabled { opacity: 0.4; cursor: not-allowed; }
</style>

<!-- Un-scoped: the scanner overlay is Teleport'd to <body>, outside this
     component's scoped-styles attribute, so selectors here apply directly. -->
<style>
.scanner-overlay {
  position: fixed;
  inset: 0;
  background: #000;
  z-index: 9999;
  display: flex;
  flex-direction: column;
  color: #fff;
  font-family: inherit;
}
.scanner-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.75rem 1rem;
  background: rgba(0, 0, 0, 0.85);
  font-size: 0.95rem;
  flex-shrink: 0;
}
.scanner-close {
  background: transparent;
  border: none;
  color: #fff;
  font-size: 1.6rem;
  line-height: 1;
  cursor: pointer;
  padding: 0 0.25rem;
}
.scanner-canvas-wrap {
  flex: 1;
  min-height: 0;
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  /* Required so pointermove on .scanner-corner isn't eaten by mobile page-scroll */
  touch-action: none;
}
.scanner-canvas-stack {
  position: relative;
  touch-action: none;
}
.scanner-canvas {
  display: block;
  width: 100%;
  height: 100%;
}
.scanner-quad {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
}
.scanner-quad polygon {
  fill: rgba(74, 144, 226, 0.18);
  stroke: #4a90e2;
  stroke-width: 2;
}
.scanner-corner {
  position: absolute;
  width: 32px;
  height: 32px;
  /* center the 32px circle on the corner's (left, top) */
  margin-left: -16px;
  margin-top: -16px;
  border-radius: 50%;
  background: rgba(74, 144, 226, 0.4);
  border: 2px solid #fff;
  box-shadow: 0 0 0 2px rgba(0, 0, 0, 0.5);
  touch-action: none;
  cursor: grab;
}
.scanner-corner:active {
  cursor: grabbing;
  background: rgba(74, 144, 226, 0.75);
}
.scanner-actions {
  display: flex;
  gap: 0.5rem;
  padding: 0.75rem;
  background: rgba(0, 0, 0, 0.85);
  flex-shrink: 0;
}
.scanner-btn {
  flex: 1;
  padding: 0.85rem 0.5rem;
  border-radius: 8px;
  border: none;
  font-size: 0.9rem;
  font-weight: 600;
  font-family: inherit;
  cursor: pointer;
}
.scanner-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.scanner-btn-secondary {
  background: #333;
  color: #fff;
}
.scanner-btn-primary {
  background: #4a90e2;
  color: #fff;
}
</style>
