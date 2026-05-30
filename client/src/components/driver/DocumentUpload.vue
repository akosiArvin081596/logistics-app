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
        <img v-if="f.isImage" :src="f.data" alt="Photo" class="thumb-clickable" title="Tap to enlarge" @click="openPreview(f)" />
        <div v-else class="doc-icon thumb-clickable" title="Tap to view" @click="openPreview(f)">
          <span class="doc-icon-emoji">&#128196;</span>
          <span class="doc-icon-name">{{ f.name }}</span>
        </div>
        <button class="thumb-remove" @click.stop="removeFile(i)">&times;</button>
        <button v-if="f.isImage" class="thumb-edit" title="Adjust" @click.stop="openAdjust(i)">&#9998;</button>
        <span class="thumb-num">{{ i + 1 }}</span>
      </div>
      <!-- Scan another page with the camera — POD/BOL only -->
      <button
        v-if="isScanDocType"
        type="button"
        class="photo-add"
        :disabled="scanning"
        title="Scan another page (camera)"
        @click="startScan"
      >
        <span>&#128247;</span>
      </button>
      <!-- Add a saved picture or file — available for every doc type (incl. POD/BOL) -->
      <label class="photo-add" :title="isScanDocType ? 'Add a saved picture or file' : 'Add another page'">
        <input
          ref="addInput"
          type="file"
          accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.csv,.txt"
          hidden
          @change="handleFile"
        />
        <span>+</span>
      </label>
      <!-- Placeholder shown while an added page is being enhanced by ScanKit -->
      <div v-if="scanning" class="photo-thumb scan-tile">
        <span class="scan-spinner"></span>
        <span>Scanning&hellip;</span>
      </div>
    </div>

    <!-- Document vs Photo scan style (POD/BOL): maps to ScanKit's filter —
         Document = clean white background, Photo = full colour (original). -->
    <div v-if="isScanDocType" class="scan-style">
      <span class="scan-style-label">Scan style</span>
      <div class="scan-style-seg">
        <button type="button" :class="['sss-btn', { on: scanFilter === 'white' }]" :disabled="scanning" @click="scanFilter = 'white'">Document</button>
        <button type="button" :class="['sss-btn', { on: scanFilter === 'original' }]" :disabled="scanning" @click="scanFilter = 'original'">Photo</button>
      </div>
    </div>

    <!-- Searchable-PDF toggle (POD/BOL scans only). When on, ScanKit returns a
         PDF with an OCR text layer instead of a flat JPEG. -->
    <label v-if="isScanDocType" class="pdf-toggle">
      <input type="checkbox" v-model="returnPdf" :disabled="scanning" />
      <span>Searchable PDF (OCR text layer)</span>
    </label>

    <!-- Initial capture/upload button -->
    <div v-if="!files.length" class="upload-buttons">
      <!-- POD/BOL: Scan replaces Take Photo (brokers reject raw camera shots) -->
      <button
        v-if="isScanDocType"
        type="button"
        class="photo-btn scan-btn"
        :disabled="scanning"
        @click="startScan"
      >
        <span v-if="!scanning">&#128196; Scan Document</span>
        <span v-else>Scanning&hellip;</span>
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

    <!-- Hidden input used by the Scan flow. Captures straight from the rear
         camera; the photo is enhanced server-side via ScanKit.io. -->
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
      :disabled="files.length === 0 || uploading || scanning"
      @click="handleUpload"
    >
      {{ uploading ? 'Uploading...' : `Upload ${selectedType} (${files.length} file${files.length !== 1 ? 's' : ''})` }}
    </button>

    <!-- Tap-to-enlarge preview of a captured/scanned page (image or searchable PDF) -->
    <Teleport to="body">
      <div v-if="previewSrc" class="dup-preview-overlay" @click="closePreview">
        <iframe v-if="previewIsPdf" :src="previewSrc" class="dup-preview-frame" title="Document preview" @click.stop></iframe>
        <img v-else :src="previewSrc" class="dup-preview-img" alt="Document preview" @click.stop />
        <button class="dup-preview-close" aria-label="Close preview" @click="closePreview">&times;</button>
      </div>
    </Teleport>

    <!-- Per-page Adjust editor: crop / rotate / B&W / brightness / contrast -->
    <ImageAdjustModal
      v-if="editIndex !== null"
      :src="files[editIndex].data"
      @apply="onAdjustApply"
      @cancel="editIndex = null"
    />
  </div>
</template>

<script setup>
import { ref, computed, watch, onBeforeUnmount } from 'vue'
import { useApi } from '../../composables/useApi'
import { useToast } from '../../composables/useToast'
import { useDocumentScan } from '../../composables/useDocumentScan'
import ImageAdjustModal from './ImageAdjustModal.vue'

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
const { scanDocument } = useDocumentScan()

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

// --- Scan state (ScanKit.io server-side; replaced the old jscanify/OpenCV). ---
const scanInput = ref(null)
const scanning = ref(false)   // true while a captured photo is being enhanced
const returnPdf = ref(false)  // per-scan toggle: searchable PDF vs cleaned image
const scanFilter = ref('white') // ScanKit filter: 'white' (Document) | 'original' (Photo/colour)
const editIndex = ref(null)     // index of the image open in the Adjust editor, or null

// Tap-to-enlarge preview of a thumbnail (image, or a searchable-PDF page).
const previewSrc = ref(null)
const previewIsPdf = ref(false)

const isScanDocType = computed(() =>
  selectedType.value === 'POD' || selectedType.value === 'BOL'
)

watch(() => props.docType, (val) => {
  if (val) selectedType.value = val
})

const headerText = computed(() => {
  const labels = { POD: 'Upload Proof of Delivery', Receipt: 'Upload Receipt', BOL: 'Upload Bill of Lading', Other: 'Upload Document' }
  return labels[selectedType.value] || 'Upload Document'
})

const hintText = computed(() => {
  if (selectedType.value === 'Receipt') return `Take photos of the receipt for Load ${props.loadId}`
  return `Take photos or upload files for Load ${props.loadId}`
})

// Decode + downscale an image to a JPEG data URL. maxEdge defaults to 1200 for
// plain uploads; the scan flow passes a larger value so ScanKit has enough
// detail to detect the document edges. createImageBitmap resizes in one pass —
// the old Image+Canvas path materialised a 12MP photo as ~48MB of raw RGBA and
// OOM-killed the tab on low-RAM phones (fix from commit 59fcd80).
async function compressImage(file, maxEdge = 1200) {
  const MAX = maxEdge
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

function openAdjust(index) {
  editIndex.value = index
}

// Replace the edited page with the adjusted image (immutable swap).
function onAdjustApply(dataUrl) {
  const i = editIndex.value
  if (i !== null && files.value[i]) {
    files.value[i] = { ...files.value[i], data: dataUrl, type: 'image/jpeg', isImage: true }
  }
  editIndex.value = null
}

let previewBlobUrl = ''

function openPreview(f) {
  closePreview()
  if (f.isImage) {
    previewSrc.value = f.data
    previewIsPdf.value = false
    return
  }
  // PDFs: a data: URI is unreliable inside <iframe> (some browsers block it),
  // so render via a blob URL instead. Fall back to the data URI on failure.
  previewIsPdf.value = true
  try {
    const [meta, b64] = String(f.data).split(',')
    const mime = (meta.match(/data:([^;]+)/) || [])[1] || 'application/pdf'
    const bin = atob(b64)
    const bytes = new Uint8Array(bin.length)
    for (let j = 0; j < bin.length; j++) bytes[j] = bin.charCodeAt(j)
    previewBlobUrl = URL.createObjectURL(new Blob([bytes], { type: mime }))
    previewSrc.value = previewBlobUrl
  } catch {
    previewSrc.value = f.data
  }
}

function closePreview() {
  previewSrc.value = null
  if (previewBlobUrl) {
    URL.revokeObjectURL(previewBlobUrl)
    previewBlobUrl = ''
  }
}

onBeforeUnmount(closePreview)

// ============================================================
// Scan: capture a photo, enhance it server-side via ScanKit.io
// ============================================================
function startScan() {
  if (scanning.value) return
  scanInput.value?.click()
}

async function handleScanFile(event) {
  const file = event.target.files && event.target.files[0]
  event.target.value = ''
  if (!file) return
  scanning.value = true
  let dataUrl = ''
  try {
    // Send a higher-res input than plain uploads so ScanKit detects edges well.
    dataUrl = await compressImage(file, 2000)
  } catch {
    scanning.value = false
    toast.show('Could not read the captured image. Please try again.', 'error')
    return
  }
  try {
    const res = await scanDocument(dataUrl, { returnPdf: returnPdf.value, filter: scanFilter.value })
    const ts = Date.now()
    files.value.push({
      data: res.data,
      name: res.isPdf ? `scan-${ts}.pdf` : `scan-${ts}.jpg`,
      type: res.contentType || (res.isPdf ? 'application/pdf' : 'image/jpeg'),
      isImage: !res.isPdf,
    })
  } catch (err) {
    handleScanError(err, dataUrl)
  } finally {
    scanning.value = false
  }
}

// On a scan failure we still attach the raw captured photo (except on rate
// limit, where the driver should just retry) so a POD/BOL upload is never
// blocked because ScanKit is down, disabled, or out of credits.
function handleScanError(err, dataUrl) {
  const status = err && err.status
  if (status === 429) {
    toast.show('Too many scans — please wait a moment and try again.', 'error')
    return
  }
  let msg = 'Scan failed — attaching your photo as-is.'
  if (status === 503) msg = "Document scanning isn't available — attaching your photo as-is."
  else if (status === 402) msg = 'Scanning temporarily unavailable — attaching your photo as-is.'
  toast.show(msg, 'error')
  if (dataUrl) {
    files.value.push({
      data: dataUrl,
      name: `photo-${Date.now()}.jpg`,
      type: 'image/jpeg',
      isImage: true,
    })
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

    // Upload each document file separately (incl. searchable-PDF scans)
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

/* Searchable-PDF toggle */
.pdf-toggle {
  display: flex;
  align-items: center;
  gap: 0.45rem;
  font-size: 0.8rem;
  color: var(--text-dim);
  margin-bottom: 0.75rem;
  cursor: pointer;
}
.pdf-toggle input { cursor: pointer; }

/* Scan-driven "+" button (POD/BOL) — same visual as the gallery + label but
   it's a <button>, so we re-declare the box styles. */
button.photo-add {
  width: 96px;
  height: 96px;
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
  width: 96px;
  height: 96px;
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
  width: 96px;
  height: 96px;
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

/* Scan-style (Document / Photo) toggle */
.scan-style { display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.6rem; }
.scan-style-label { font-size: 0.8rem; color: var(--text-dim); }
.scan-style-seg { display: flex; border: 1px solid var(--border); border-radius: 6px; overflow: hidden; }
.sss-btn {
  padding: 0.35rem 0.7rem;
  border: none;
  background: var(--surface);
  color: var(--text-dim);
  font-family: inherit;
  font-size: 0.8rem;
  cursor: pointer;
}
.sss-btn.on { background: var(--accent); color: #fff; font-weight: 600; }
.sss-btn:disabled { opacity: 0.6; cursor: progress; }

/* Adjust (pencil) button on image thumbnails */
.thumb-edit {
  position: absolute;
  bottom: 2px;
  right: 2px;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.6);
  color: #fff;
  border: none;
  font-size: 0.7rem;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  line-height: 1;
}

/* Scanning placeholder tile (added-page enhancement in flight) */
.scan-tile {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.3rem;
  background: var(--bg);
  color: var(--text-dim);
  font-size: 0.6rem;
}
.scan-spinner {
  width: 20px;
  height: 20px;
  border: 2px solid var(--border);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: dup-spin 0.8s linear infinite;
}
@keyframes dup-spin { to { transform: rotate(360deg); } }

/* Tap-to-enlarge preview */
.thumb-clickable { cursor: zoom-in; }
.dup-preview-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.85);
  z-index: 10000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1rem;
}
.dup-preview-img {
  max-width: 96vw;
  max-height: 92vh;
  object-fit: contain;
  border-radius: 6px;
  box-shadow: 0 4px 24px rgba(0, 0, 0, 0.5);
}
.dup-preview-frame {
  width: 96vw;
  height: 92vh;
  border: none;
  border-radius: 6px;
  background: #fff;
}
.dup-preview-close {
  position: fixed;
  top: 1rem;
  right: 1rem;
  width: 40px;
  height: 40px;
  border-radius: 50%;
  border: none;
  background: rgba(0, 0, 0, 0.6);
  color: #fff;
  font-size: 1.5rem;
  line-height: 1;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
}
</style>
