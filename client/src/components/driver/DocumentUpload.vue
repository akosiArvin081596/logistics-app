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
          multiple
          hidden
          @change="handleFile"
        />
        <span>+</span>
      </label>
      <!-- Placeholder shown while a captured page is being enhanced by ScanKit -->
      <div v-if="scanning" class="photo-thumb scan-tile">
        <span class="scan-spinner"></span>
        <span>Scanning&hellip;</span>
      </div>
    </div>

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
          multiple
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
      {{ uploading ? (progress.total > 1 ? `Uploading ${progress.done}/${progress.total}…` : 'Uploading…') : `Upload ${selectedType} (${files.length} file${files.length !== 1 ? 's' : ''})` }}
    </button>

    <!-- Tap-to-enlarge preview of a captured/scanned page (image or PDF) -->
    <Teleport to="body">
      <div v-if="previewSrc" class="dup-preview-overlay" @click="closePreview">
        <iframe v-if="previewIsPdf" :src="previewSrc" class="dup-preview-frame" title="Document preview" @click.stop></iframe>
        <img v-else :src="previewSrc" class="dup-preview-img" alt="Document preview" @click.stop />
        <button class="dup-preview-close" aria-label="Close preview" @click="closePreview">&times;</button>
      </div>
    </Teleport>
  </div>
</template>

<script setup>
import { ref, computed, watch, onBeforeUnmount } from 'vue'
import { useToast } from '../../composables/useToast'
import { useDocumentScan } from '../../composables/useDocumentScan'
import { useUpload } from '../../composables/useUpload'
import { compressImage, readFileAsDataURL, SCAN_MAX_EDGE } from '../../lib/imageUtils'

const props = defineProps({
  loadId: { type: String, required: true },
  driverName: { type: String, required: true },
  rowIndex: { type: Number, required: true },
  docType: { type: String, default: null },
  showTypeSelector: { type: Boolean, default: true },
})

const emit = defineEmits(['uploaded'])

const toast = useToast()
const { scanDocument } = useDocumentScan()
const { uploadDocuments, uploading, progress } = useUpload()

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

// --- Scan state (ScanKit.io server-side; replaced the old jscanify/OpenCV). ---
const scanInput = ref(null)
const scanning = ref(false)   // true while a captured photo is being enhanced

// Tap-to-enlarge preview of a thumbnail (image, or an uploaded PDF).
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

async function handleFile(event) {
  // The file inputs allow multi-select, so a driver can attach several pages or
  // photos in one pick instead of one at a time. Process each in turn (images
  // are compressed; other files read as-is) and append to the page list.
  const selected = Array.from(event.target.files || [])
  if (!selected.length) return

  for (const file of selected) {
    if (file.type.startsWith('image/')) {
      const data = await compressImage(file)
      files.value.push({ data, name: file.name, type: file.type, isImage: true })
    } else {
      const data = await readFileAsDataURL(file)
      files.value.push({ data, name: file.name, type: file.type, isImage: false })
    }
  }
  event.target.value = ''
}

function removeFile(index) {
  files.value.splice(index, 1)
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
// Scan: capture a photo, enhance it server-side via ScanKit.io.
// Direct flow — capture → convert to a clean document → show it.
// No adjustment step; on upload the image is saved as a PDF.
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
    dataUrl = await compressImage(file, SCAN_MAX_EDGE)
  } catch {
    scanning.value = false
    toast.show('Could not read the captured image. Please try again.', 'error')
    return
  }
  try {
    // Clean-document filter, image output — the server turns it into a PDF on upload.
    const res = await scanDocument(dataUrl, { filter: 'white' })
    const ts = Date.now()
    files.value.push({
      data: res.data,
      name: `scan-${ts}.jpg`,
      type: res.contentType || 'image/jpeg',
      isImage: true,
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

  const fileCount = files.value.length
  const images = files.value.filter(f => f.isImage)
  const docs = files.value.filter(f => !f.isImage)

  // All images ride in ONE POST as a photoData array — the server stitches them
  // into a single multi-page PDF. Each non-image doc is its own POST. `taskSrc`
  // maps each task back to the exact file object(s) it carries, so a partial
  // failure re-tains only what didn't land — matched by object identity, so two
  // files sharing a name can't alias each other on retry.
  const imageLabel = images.length
    ? `${selectedType.value} (${images.length} page${images.length !== 1 ? 's' : ''})`
    : ''
  const tasks = []
  const taskSrc = []
  if (images.length) {
    tasks.push({
      label: imageLabel,
      body: {
        loadId: props.loadId,
        rowIndex: props.rowIndex,
        docType: selectedType.value,
        photoData: images.length === 1 ? images[0].data : images.map(f => f.data),
        driverName: props.driverName,
        fileType: 'image',
      },
    })
    taskSrc.push(images)
  }
  for (const doc of docs) {
    tasks.push({
      label: doc.name,
      body: {
        loadId: props.loadId,
        rowIndex: props.rowIndex,
        docType: selectedType.value,
        photoData: doc.data,
        driverName: props.driverName,
        fileType: 'document',
        fileName: doc.name,
      },
    })
    taskSrc.push([doc])
  }

  // useUpload posts each task with retry + a 90s timeout and reports per-task
  // outcomes by index. It owns the `uploading` / `progress` refs the button reads.
  const { failed } = await uploadDocuments(tasks)

  if (failed.length === 0) {
    toast.show(`${selectedType.value} uploaded (${fileCount} file${fileCount !== 1 ? 's' : ''})`)
    emit('uploaded', { type: selectedType.value })
    files.value = []
    return
  }

  // Keep only the files whose task failed so re-tapping Upload retries just those;
  // the ones that already landed are dropped to avoid duplicate uploads server-side.
  // Match by object identity (not filename) so duplicate names can't drop a file.
  const keep = new Set()
  for (const f of failed) for (const src of (taskSrc[f.index] || [])) keep.add(src)
  files.value = files.value.filter(file => keep.has(file))
  toast.show(`Upload failed for ${failed.length} item${failed.length !== 1 ? 's' : ''} — tap Upload to retry.`, 'error')
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

/* Scanning placeholder tile (capture enhancement in flight) */
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
