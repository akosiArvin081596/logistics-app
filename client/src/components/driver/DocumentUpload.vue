<template>
  <!-- The WHOLE card is the drop target. v-bind="dropzoneProps" adds only the
       four drag listeners — no attributes, no classes, no extra elements — so
       the admin dashboard (ActiveLoadsTab / CompletedLoadsTab mount this inside
       their load modal) is laid out exactly as before.

       ⚠️ The four file inputs below are deliberately NOT bound to useFileDrop's
       inputProps. See UPLOAD_ACCEPT in the script for why. -->
  <div class="card doc-upload" :class="{ 'doc-upload-over': dragActive }" v-bind="dropzoneProps">
    <div class="doc-header">{{ headerText }}</div>
    <p class="doc-hint">{{ dragActive ? 'Drop the files here to attach them' : hintText }}</p>

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
      <!-- :key is the entry's own id, NOT the index. A tile can now be removed
           while its neighbours are still filling in, and index keys make Vue
           reuse DOM by position — removing tile 2 mid-batch would re-point tile
           3's <img> at tile 2's slot and swap a spinner with the wrong photo. -->
      <div v-for="(f, i) in files" :key="f.key" class="photo-thumb" :class="{ 'scan-tile': isPending(f) }">
        <!-- A placeholder holds no bytes yet: <img src=""> fires a broken-image
             request and openPreview would open an empty overlay, so a pending
             tile gets NO click target rather than a disabled one. -->
        <template v-if="isPending(f)">
          <span class="scan-spinner"></span>
          <span>Scanning&hellip;</span>
        </template>
        <img v-else-if="f.isImage" :src="f.data" alt="Photo" class="thumb-clickable" title="Tap to enlarge" @click="openPreview(f)" />
        <div v-else class="doc-icon thumb-clickable" title="Tap to view" @click="openPreview(f)">
          <span class="doc-icon-emoji">&#128196;</span>
          <span class="doc-icon-name">{{ f.name }}</span>
        </div>
        <!-- Removal passes the ENTRY, never the index — a scan resolving while
             the array shifts underneath would otherwise write its page into
             whichever tile happens to occupy that slot now. -->
        <button class="thumb-remove" @click.stop="removeFile(f)">&times;</button>
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
      <!-- The standalone v-if="scanning" tile that used to sit here is gone:
           placeholders now occupy the grid in pick order, so it would render an
           extra phantom tile beside them. -->
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
      @change="handleScanFiles"
    />
    <!-- The same ScanKit pipeline, MULTI-select, and deliberately NO `capture`.
         ⚠️ Two inputs rather than one with both attributes, for the reason
         stated at UPLOAD_ACCEPT below: `capture` and `multiple` are resolved
         together by the platform file-chooser intent, and which one wins is not
         uniform across Android Chrome / Samsung Internet / in-app WebViews. A
         phone that answers `multiple` by opening the FILE BROWSER instead of
         the camera breaks the one flow every driver uses. e0cf78f already made
         this call once — it added `multiple` to every input EXCEPT the capture
         ones ("Camera capture stays one-shot per tap"). Two inputs keep each
         one's behaviour literal and independently readable. -->
    <input
      ref="scanPickInput"
      type="file"
      accept="image/*"
      multiple
      hidden
      @change="handleScanFiles"
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
import { useFileDrop } from '../../composables/useFileDrop'
import { compressImage, isDecodedImage, readFileAsDataURL, SCAN_MAX_EDGE } from '../../lib/imageUtils'
import { runPool } from '../../lib/asyncPool'

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
const files = ref([]) // see makeEntry for the shape

// Every entry carries a stable `key` and a `status`.
//
// `key`: the grid used :key="i", correct for an append-only list of finished
// pages and wrong the moment a tile can be removed while its neighbours are
// still filling in. See the comment on the v-for.
//
// `status`: 'queued' | 'scanning' -> 'done'. Only a 'done' entry carries bytes.
// Anything that arrives already complete (a plain upload, a drop) is born
// 'done'. Mirrors BulkReceiptScan's OCR_PENDING / scanFinished pair.
let entrySeq = 0
function makeEntry(fields) {
  return {
    key: `p${entrySeq++}`,
    data: '',
    name: '',
    type: '',
    isImage: true,
    status: 'done',
    outcome: '',   // '' | 'scanned' | 'raw' | 'unreadable' | 'cancelled'
    _file: null,
    ...fields,
  }
}

const PENDING = new Set(['queued', 'scanning'])
const isPending = (f) => PENDING.has(f.status)

// ⚠️ Kept in sync BY HAND with the accept attribute on the "+ add page" and
// "Upload File" inputs in the template. All four file inputs stay LITERAL
// markup on purpose: useFileDrop's inputProps omits `capture` only when it is
// blank, and rendering a BLANK capture attribute on the Take Photo / Scan
// inputs makes a phone open the FILE BROWSER instead of the camera — which is
// how every driver photographs a POD. Nothing is worth risking that, so the
// drop target is the card and the inputs are left alone.
const UPLOAD_ACCEPT = 'image/*,.pdf,.doc,.docx,.xls,.xlsx,.csv,.txt'

// ONE composable instance for the whole card. A drop routes to handleFiles —
// the normal upload path — and NEVER to handleScanFiles, which is the separate
// ScanKit pipeline behind the camera.
const { dropzoneProps, dragActive, supportsDrag, error: dropError, clearMessages: clearDropError } = useFileDrop({
  multiple: true,
  accept: UPLOAD_ACCEPT,
  onFiles: handleFiles,
})

// Refusals reuse this component's existing toast channel, the same way an
// undecodable page already reports itself.
// ⚠️ Watched on the `error` REF, not through onReject. A dropped FOLDER is
// caught before validation runs and so is never reported through onReject — it
// only ever lands on this ref. Surfacing rejections alone would leave the
// commonest mis-drop of all completely silent.
watch(dropError, (msg) => {
  if (!msg) return
  toast.show(msg, 'error')
  clearDropError()
})

// --- Scan state (ScanKit.io server-side; replaced the old jscanify/OpenCV). ---
const scanInput = ref(null)
const scanPickInput = ref(null)

// Replaces the old `scanning` ref. Every existing :disabled binding and v-if
// reads it unchanged — a computed unwraps in the template exactly like a ref.
// ⚠️ The ref had a `finally { scanning.value = false }` backstop; this does not.
// The guarantee now lives in scanOne's own finally, which must ALWAYS leave an
// entry at 'done'. One stranded placeholder disables Upload permanently.
const scanning = computed(() => files.value.some(isPending))

// Parallel ScanKit round trips. Matches BulkReceiptScan's OCR_CONCURRENCY, and
// for the same reason — modest, so one batch can't drain scanKitLimiter's
// 120/15min or the account's credits in a burst.
const SCAN_CONCURRENCY = 3

// Cap on the GRID, not on the pick: every image in this card rides in ONE
// /api/documents/upload POST (the server stitches them into a single multi-page
// PDF), so three picks of ten is one thirty-page body.
//   · the 50MB POST — a SCAN_MAX_EDGE JPEG is ~0.3-0.5MB base64, so twenty is
//     ~8MB, well inside express.json's limit with room for a dense page and any
//     non-image docs attached alongside.
//   · scanKitLimiter — 120 per 15 min keyed per USER, so six full batches.
// The 8,500,000-char per-image scan cap never binds: compressImage's only
// output that large is its raw-bytes fallback, which isDecodedImage rejects
// before a request is built. Phone memory (N decoded 1280px bitmaps held live)
// would bind sooner than any of these, but the multi-select door is desktop-only
// by construction — a phone reaches this pipeline one camera shot at a time.
const MAX_SCAN_PAGES = 20

// One hard failure disables the scan pass for the REST of this batch. Same
// reasoning as BulkReceiptScan's enhanceDisabled: a service that is off, out of
// credits, or rate-limiting us answers identically for every remaining page, so
// re-asking is N doomed 30s round trips that delay the whole grid and make the
// tiles look frozen. Reset per batch, so it self-heals.
//
// The floor is SCAN_CONCURRENCY, not one: the workers already in flight when
// the first failure lands cannot be un-fired, so a failing batch costs 3 calls
// however long it is (measured: 3 for 6 pages, and 3 for 20). Seeing three
// requests in the network tab is the breaker working, not leaking.
//
// ⚠️ Two statuses differ from BulkReceiptScan's ENHANCE_OFF_STATUS, on purpose:
//   429 — excluded there because a receipt batch can afford to keep asking.
//     Here it is usually our own scanKitLimiter, keyed PER USER over 15 minutes:
//     once it fires the window is burned and every remaining page 429s too.
//   502 — server.js masks SCANKIT_NO_KEY and SCANKIT_AUTH as a generic 502 so a
//     driver device never learns the company key is bad. Those are the permanent
//     failures, so they belong here; the cost of catching a transient upstream
//     blip is that the rest of the batch attaches raw, which is still a
//     complete, uploadable POD.
const SCAN_OFF_STATUS = new Set([401, 402, 403, 429, 502, 503])
let scanOffStatus = 0 // the status that tripped it, for the summary's wording

// The exact sentences the single-file path used, keyed by status so the
// aggregate toast can say the same true thing about N pages.
const SCAN_OFF_REASON = {
  503: "Document scanning isn't available",
  402: 'Scanning temporarily unavailable',
  429: 'Too many scans — try again in a few minutes',
}

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
  const base = selectedType.value === 'Receipt'
    ? `Take photos of the receipt for Load ${props.loadId}`
    : `Take photos or upload files for Load ${props.loadId}`
  // Copy only, and desktop only — supportsDrag is false on touch, where "drag"
  // is an instruction nobody can follow. It gates no handler.
  return supportsDrag.value ? `${base} — or drag files onto this card` : base
})

// DOM wrapper for the three <input type="file"> @change bindings. Kept so the
// inputs themselves need no edit at all.
// ⚠️ The input is cleared BEFORE handling, not after. Without that, re-picking
// the same file after a refusal fires no change event at all, so the driver's
// obvious recovery — take it again, pick it again — silently does nothing.
function handleFile(event) {
  const selected = Array.from(event.target.files || [])
  event.target.value = ''
  return handleFiles(selected)
}

async function handleFiles(selected) {
  // Both entry points are multi-file — the inputs allow multi-select so a driver
  // can attach several pages in one pick, and a drop can carry a handful at
  // once. Process each in turn (images are compressed; other files read as-is)
  // and append to the page list.
  const list = Array.from(selected || [])
  if (!list.length) return

  const refused = []
  for (const file of list) {
    if (file.type.startsWith('image/')) {
      const data = await compressImage(file)
      // compressImage falls back to the RAW bytes when it cannot decode a file,
      // so a non-JPEG/PNG/WebP result here is an undecodable "image": an SVG
      // (which passes accept="image/*" and can carry script), a mislabelled
      // document, a HEIC even heic2any refused. Attaching it anyway files it as
      // a page, and the server — which verifies the real magic bytes — rejects
      // the whole upload, taking the good pages beside it down too.
      if (!isDecodedImage(data)) {
        refused.push(file.name || 'photo')
        continue
      }
      files.value.push(makeEntry({ data, name: file.name, type: file.type, isImage: true }))
    } else {
      const data = await readFileAsDataURL(file)
      // '' is a FileReader error on an unreadable/corrupt file — attaching it
      // uploads an empty document under a perfectly convincing filename.
      if (!data) {
        refused.push(file.name || 'file')
        continue
      }
      files.value.push(makeEntry({ data, name: file.name, type: file.type, isImage: false }))
    }
  }

  // Named, so the driver knows WHICH page is missing from the grid — the others
  // stayed attached and the upload is still worth sending.
  if (refused.length) {
    const what = refused.length > 1 ? 'those' : 'it'
    toast.show(`Couldn't read ${refused.join(', ')} — try photographing ${what} with the camera instead.`, 'error')
  }
}

// Splices in place rather than reassigning files.value, so nothing holding a
// reference to the array is invalidated. indexOf is proxy-aware in Vue 3, so
// this matches whether the caller hands us a proxy or a raw target.
// Removing a PENDING tile is allowed and is the user's cancel: the worker keeps
// running but writes into a now-detached object, which is harmless precisely
// because it mutates in place and never pushes.
function removeFile(entry) {
  const i = files.value.indexOf(entry)
  if (i !== -1) files.value.splice(i, 1)
}

let previewBlobUrl = ''

function openPreview(f) {
  // Belt-and-braces: the template gives a pending tile no click target, but a
  // future caller shouldn't be able to open an empty overlay. Must sit BEFORE
  // closePreview(), or a stray call would close a preview legitimately open.
  if (!f?.data) return
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
// Which door startScan opens. NOT viewport width: a dispatcher with a narrow
// browser window is still on a desktop and would be handed the camera input.
// `(pointer: coarse)` asks the question we actually care about — is the primary
// pointer a finger — true on phones and tablets (where `capture` really does
// open the camera) and false on desktops and mouse-driven touchscreen laptops.
// Unknown environments fall through to the CAMERA, because that is the flow
// that must never break.
function prefersCamera() {
  if (typeof window.matchMedia !== 'function') return true
  return window.matchMedia('(pointer: coarse)').matches
}

function startScan() {
  if (scanning.value) return
  ;(prefersCamera() ? scanInput.value : scanPickInput.value)?.click()
}

// Attach the un-enhanced photo so a POD/BOL upload is never blocked because
// ScanKit is down, disabled, out of credits or rate-limiting us.
function attachRaw(entry, dataUrl) {
  if (!dataUrl) {
    entry.outcome = 'unreadable'
    removeFile(entry)
    return
  }
  entry.data = dataUrl
  entry.name = `photo-${Date.now()}-${entry.key}.jpg`
  entry.type = 'image/jpeg'
  entry.outcome = 'raw'
}

// Fill one placeholder. NEVER THROWS — see the contract on runPool. Owns the
// entry's terminal status and its outcome bucket, and pushes NOTHING: the tile
// already exists, so a tile removed mid-flight stays removed instead of
// reappearing when its scan lands.
async function scanOne(entry) {
  let raw = ''
  try {
    // The tile may have been removed while it sat in the queue. Continuing is
    // harmless (we'd mutate a detached object) but spends a ScanKit credit and
    // a 30s pool slot on a page nobody wants.
    if (!files.value.includes(entry)) {
      entry.outcome = 'cancelled'
      return
    }
    entry.status = 'scanning'

    // Send a higher-res input than plain uploads so ScanKit detects edges well.
    try {
      raw = await compressImage(entry._file, SCAN_MAX_EDGE)
    } catch {
      raw = ''
    }
    // Covers both an empty result and compressImage's raw-bytes fallback. The
    // reasoning is unchanged and costs MORE in a batch, not less: the server
    // verifies real magic bytes, so one undecodable page 400s the single POST
    // that carries every other page with it.
    if (!isDecodedImage(raw)) {
      entry.outcome = 'unreadable'
      removeFile(entry)
      return
    }

    // Breaker already tripped by an earlier page in this batch — skip the round
    // trip entirely and take the fallback straight away.
    if (scanOffStatus) {
      attachRaw(entry, raw)
      return
    }

    // Clean-document filter, image output — the server turns it into a PDF on upload.
    const res = await scanDocument(raw, { filter: 'white' })
    // ⚠️ Not in the old single-file version, and it matters more here. If
    // ScanKit ever answers with a PDF (or anything an <img> can't draw), the
    // entry is still flagged isImage and rides in handleUpload's photoData
    // ARRAY — where the server's isValidImageMagic rejects it and takes every
    // other page down with it. Falling back to the raw photo is the same trade
    // the 402/503 path already makes.
    if (!isDecodedImage(res?.data)) {
      attachRaw(entry, raw)
      return
    }
    entry.data = res.data
    entry.name = `scan-${Date.now()}-${entry.key}.jpg`
    entry.type = res.contentType || 'image/jpeg'
    entry.outcome = 'scanned'
  } catch (err) {
    const s = err?.status
    if (SCAN_OFF_STATUS.has(s)) scanOffStatus = s
    attachRaw(entry, raw)
  } finally {
    // The one guarantee that replaces `finally { scanning.value = false }`. A
    // placeholder that never reaches 'done' disables Upload forever, because
    // `scanning` is now a computed over exactly this field.
    entry.status = 'done'
    entry._file = null   // release the File
  }
}

async function handleScanFiles(event) {
  // Snapshot BEFORE clearing — setting input.value = '' empties input.files.
  // Cleared FIRST for the reason given on handleFile: without it, re-picking
  // the same file after a refusal fires no change event at all, so the obvious
  // recovery silently does nothing.
  const picked = Array.from(event.target.files || [])
  event.target.value = ''
  if (!picked.length) return

  const remaining = MAX_SCAN_PAGES - files.value.length
  if (remaining <= 0) {
    toast.show(`Max ${MAX_SCAN_PAGES} pages — upload or remove some first.`, 'error')
    return
  }
  // ⚠️ The trim is reported by summarizeScan, NOT toasted here. useToast holds
  // one global message, so an immediate notice is overwritten by the summary
  // the moment the batch settles — which, when ScanKit is answering 503, is
  // fast enough that the user never sees it and the truncation reads as silent.
  let toScan = picked
  const trimmed = picked.length - Math.min(picked.length, remaining)
  if (trimmed) toScan = picked.slice(0, remaining)

  // Fresh chance for the scanner each batch — but only when nothing else is in
  // flight, so a second pick can't un-trip a breaker the first pick earned.
  if (!scanning.value) scanOffStatus = 0

  // Placeholders FIRST, in pick order, so every tile is on screen before the
  // first round trip — that is what replaces the click/wait/click loop.
  // ⚠️ `batch` is re-read out of files.value on purpose. Pushing a plain object
  // into a reactive array stores the RAW target; mutating that raw object never
  // notifies the proxy and THE TILES NEVER REPAINT. Same trap, same fix, as
  // BulkReceiptScan's `const added = rows.value.slice(start)`.
  const start = files.value.length
  for (const file of toScan) {
    files.value.push(makeEntry({ name: file.name || 'page', status: 'queued', _file: file }))
  }
  const batch = files.value.slice(start) // reactive proxies for the new entries

  await runPool(batch, scanOne, SCAN_CONCURRENCY)
  summarizeScan(batch, trimmed)
}

// ONE toast per pick. Not a preference — useToast holds a SINGLE global message
// on a shared timer, so N per-file toasts do not stack: each show() overwrites
// the last and resets the timer, and the user sees only whichever page happened
// to fail most recently.
//
// Silence on a clean batch is deliberate and preserves today's behaviour
// exactly: a successful scan has never toasted, and a grid of finished tiles is
// its own confirmation. This exists to make a silent failure loud, nothing else.
function summarizeScan(batch, trimmed = 0) {
  const raw = batch.filter(f => f.outcome === 'raw').length
  const unreadable = batch.filter(f => f.outcome === 'unreadable')
  if (!raw && !unreadable.length && !trimmed) return

  const parts = []
  // First, because it is the one thing the grid alone cannot tell the user:
  // twenty tiles look identical whether they picked twenty or twenty-five.
  if (trimmed) parts.push(`${MAX_SCAN_PAGES}-page limit — ${trimmed} not added.`)
  if (raw) {
    // "attached as-is" is the load-bearing phrase: the page IS on the upload,
    // only the cleanup was skipped. Without it this reads as "your photos were
    // lost". ⚠️ 429 now attaches raw too, where the single-file path used to
    // attach nothing — in a batch, discarding pages already captured and
    // compressed costs the user work they did standing at a dock, and the
    // 402/503 path already gives up that same cleanliness property.
    const why = SCAN_OFF_REASON[scanOffStatus] || 'Scan failed'
    parts.push(`${why} — ${raw} page${raw === 1 ? '' : 's'} attached as-is.`)
  }
  if (unreadable.length) {
    // Named, so the user knows WHICH page is missing from the grid — the same
    // rule handleFiles states for a refused upload.
    const names = unreadable.map(f => f.name).join(', ')
    parts.push(`Couldn't read ${names} — take ${unreadable.length > 1 ? 'them' : 'it'} again.`)
  }
  toast.show(parts.join(' '), 'error')
}

async function handleUpload() {
  if (uploading.value) return

  // ⚠️ A placeholder carries no bytes. photoData: '' is a 400, and since ALL
  // images ride in ONE POST that 400 takes every good page beside it down too.
  // The Upload button is :disabled while `scanning`, but that is not sufficient
  // on its own: the "+" tile is gated on `scanning` and NOT on `uploading`, so
  // a new scan can legitimately start while an upload is already in flight.
  const ready = files.value.filter(f => f.data)
  if (!ready.length) return

  const fileCount = ready.length
  const images = ready.filter(f => f.isImage)
  const docs = ready.filter(f => !f.isImage)

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

  // Only entries THIS upload actually sent may leave the grid. A bare
  // `files.value = []` would also wipe any placeholder a concurrent scan pushed
  // while the POST was in flight.
  const sent = new Set(ready)

  if (failed.length === 0) {
    toast.show(`${selectedType.value} uploaded (${fileCount} file${fileCount !== 1 ? 's' : ''})`)
    emit('uploaded', { type: selectedType.value })
    files.value = files.value.filter(f => !sent.has(f))
    return
  }

  // Keep only the files whose task failed so re-tapping Upload retries just those;
  // the ones that already landed are dropped to avoid duplicate uploads server-side.
  // Match by object identity (not filename) so duplicate names can't drop a file.
  const keep = new Set()
  for (const f of failed) for (const src of (taskSrc[f.index] || [])) keep.add(src)
  // One rule covering both cases: only what we sent may be dropped, and only if
  // it landed. Anything attached after the POST began is untouched.
  files.value = files.value.filter(f => !sent.has(f) || keep.has(f))
  toast.show(`Upload failed for ${failed.length} item${failed.length !== 1 ? 's' : ''} — tap Upload to retry.`, 'error')
}
</script>

<style scoped>
.doc-upload {
  margin-top: 1rem;
  transition: background 0.15s, border-color 0.15s;
}

/* Drag highlight. Deliberately a colour change only — recolouring the existing
   1px border and tinting the fill costs no layout, so the card cannot jump
   under the pointer mid-drag. An outline was rejected because .card sets
   overflow:hidden and this component is mounted inside the dashboard's load
   modal, where an outline can be clipped by an ancestor. Never seen on a phone:
   dragActive can only become true from real drag events. */
.doc-upload-over {
  border-color: var(--accent);
  background: var(--accent-dim);
  box-shadow: inset 0 0 0 1px var(--accent);
}
@media (prefers-reduced-motion: reduce) {
  .doc-upload { transition: none; }
}

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
