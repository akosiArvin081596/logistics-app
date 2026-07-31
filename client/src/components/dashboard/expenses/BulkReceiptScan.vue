<template>
  <div class="bulk-scan">
    <div class="bulk-intro">
      <div class="bulk-title">Bulk Receipt Upload</div>
      <p class="bulk-sub">
        Pick a driver, drop in a stack of receipts, and each one is scanned into an
        editable row. Review the reads, fix anything off, then save them all as
        expenses. Photos <em>and</em> PDFs are auto-read (PDFs up to 6&nbsp;MB).
        iPhone (HEIC) photos supported.
      </p>
    </div>

    <!-- Resume banner: an in-progress batch saved server-side (e.g. started on a
         phone) is offered for pickup on this device. Suppresses auto-save until
         the user resolves it so we never overwrite the saved draft. -->
    <div v-if="pendingDraft" class="bulk-resume">
      <div class="bulk-resume-text">
        <strong>Resume in-progress upload?</strong>
        <span>
          {{ pendingDraft.rows.length }} receipt{{ pendingDraft.rows.length === 1 ? '' : 's' }}
          in progress{{ pendingDraftWhen ? ` (saved ${pendingDraftWhen})` : '' }} — pick up where
          you left off, e.g. from your phone.
        </span>
      </div>
      <div class="bulk-resume-actions">
        <button type="button" class="bulk-save bulk-resume-yes" @click="resumeDraft">Resume</button>
        <button type="button" class="bulk-btn-ghost" @click="discardDraft">Discard</button>
      </div>
    </div>

    <!-- Controls: default driver + file picker -->
    <div class="bulk-controls">
      <div class="bulk-control">
        <label class="bulk-label">Default driver</label>
        <select v-model="defaultDriver" class="bulk-input" :disabled="processing || saving">
          <option value="">Select driver…</option>
          <option v-for="d in drivers" :key="d" :value="d">{{ d }}</option>
        </select>
      </div>

      <button
        v-if="rows.length"
        type="button"
        class="bulk-btn-ghost"
        :disabled="!defaultDriver || processing || saving"
        title="Set every row to the default driver"
        @click="applyDefaultToAll"
      >Apply to all rows</button>

      <label class="bulk-add" :class="{ disabled: atCapacity || processing || saving }">
        <input
          ref="fileInputRef"
          type="file"
          accept="image/*,.heic,.heif,application/pdf"
          multiple
          class="bulk-file-input"
          :disabled="atCapacity || processing || saving"
          @change="onFilesSelected"
        />
        + Add receipts
      </label>

      <button
        v-if="rows.length"
        type="button"
        class="bulk-btn-ghost bulk-clear"
        :disabled="processing || saving"
        @click="clearAll"
      >Clear all</button>

      <!-- Sits beside the Add control, where it's read at the moment of choosing
           files: a multi-page PDF is ONE document to the scanner, so several
           receipts bundled into one file become a single expense. -->
      <p class="bulk-pdf-note">
        <strong>One receipt per file.</strong> A multi-page PDF is read as a single
        expense &mdash; split bundled receipts before uploading.
      </p>

      <span class="bulk-count">{{ rows.length }} / {{ MAX_BATCH }}</span>
    </div>

    <!-- Scan progress -->
    <div v-if="processing" class="bulk-progress">
      <div class="bulk-progress-bar">
        <div class="bulk-progress-fill" :style="{ width: progressPct + '%' }"></div>
      </div>
      <span class="bulk-progress-label">Scanning {{ progress.done }} / {{ progress.total }}…</span>
    </div>

    <!-- Empty state -->
    <div v-if="!rows.length && !processing" class="bulk-empty">
      No receipts added yet. Choose a default driver and click <strong>+ Add receipts</strong>.
    </div>

    <!-- Review grid (desktop) -->
    <div v-if="rows.length && !isMobile" class="bulk-grid-wrap">
      <table class="bulk-grid">
        <thead>
          <tr>
            <th class="col-thumb">Receipt</th>
            <th class="col-status">Scan</th>
            <th class="col-amount">Amount *</th>
            <th class="col-date">Date *</th>
            <th class="col-type">Type</th>
            <th class="col-vendor">Vendor</th>
            <th class="col-city">City</th>
            <th class="col-state">ST</th>
            <th class="col-driver">Driver *</th>
            <th class="col-remove"></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in rows" :key="row.key" :class="rowClass(row)">
            <td class="col-thumb">
              <img
                v-if="row.thumb"
                :src="row.thumb"
                class="bulk-thumb"
                :alt="row.fileName"
                @click="previewImg = row.thumb"
              />
              <span v-else-if="row.isPdf" class="bulk-pdf-chip" :title="row.fileName">PDF</span>
              <span v-else class="bulk-thumb-ph"></span>
            </td>
            <td class="col-status">
              <span class="bulk-oc" :class="`oc-${row.ocrStatus}`" :title="ocrTitle(row)">
                {{ OCR_LABEL[row.ocrStatus] || row.ocrStatus }}
                <span v-if="row.ocrStatus === 'ok' && row.confidence" class="oc-conf">· {{ row.confidence }}</span>
              </span>
            </td>
            <td class="col-amount">
              <input v-model="row.amount" type="number" step="0.01" min="0" placeholder="0.00" class="bulk-cell" :disabled="saving" />
            </td>
            <td class="col-date">
              <input
                v-model="row.date"
                type="date"
                class="bulk-cell"
                :class="{ 'cell-error': row.saveStatus === 'invalid' && !row.date, 'cell-warn': !row.date && row.saveStatus !== 'invalid' }"
                :disabled="saving"
                :title="!row.date ? 'Verify the purchase date — it was not read from the receipt' : ''"
              />
              <span v-if="!row.date" class="cell-hint-warn">verify date</span>
            </td>
            <td class="col-type">
              <select v-model="row.type" class="bulk-cell" :disabled="saving">
                <option v-for="t in expenseTypes" :key="t" :value="t">{{ t }}</option>
              </select>
            </td>
            <td class="col-vendor">
              <input v-model="row.vendor" type="text" placeholder="Vendor" class="bulk-cell" maxlength="80" :disabled="saving" />
            </td>
            <td class="col-city">
              <input v-model="row.city" type="text" placeholder="City" class="bulk-cell" maxlength="60" :disabled="saving" />
            </td>
            <td class="col-state">
              <input
                v-model="row.state"
                type="text"
                placeholder="ST"
                class="bulk-cell bulk-cell-st"
                maxlength="2"
                :disabled="saving"
                @input="row.state = row.state.toUpperCase()"
              />
            </td>
            <td class="col-driver">
              <select v-model="row.driver" class="bulk-cell" :class="{ 'cell-error': row.saveStatus === 'invalid' && !row.driver }" :disabled="saving">
                <option value="">Driver…</option>
                <option v-for="d in drivers" :key="d" :value="d">{{ d }}</option>
              </select>
            </td>
            <td class="col-remove">
              <span v-if="row.saveStatus === 'saving'" class="bulk-row-msg">…</span>
              <div v-else class="bulk-cell-actions">
                <button v-if="row.saveStatus === 'timeout'" type="button" class="bulk-retry" :disabled="saving || processing" :title="row.saveError" @click="retryRow(row)">Retry</button>
                <span v-else-if="row.saveStatus === 'duplicate'" class="bulk-row-msg dup" :title="row.saveError">dup</span>
                <span v-else-if="row.saveStatus === 'error'" class="bulk-row-msg err" :title="row.saveError">!</span>
                <span v-else-if="row.saveStatus === 'invalid'" class="bulk-row-msg err" :title="row.saveError">fix</span>
                <button type="button" class="bulk-remove" :disabled="saving || processing" aria-label="Remove receipt" @click="removeRow(row.key)">&times;</button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Review cards (mobile) — each receipt is a tappable card that clearly
         shows its state + thumb, and expands to edit the fields. -->
    <div v-if="rows.length && isMobile" class="bulk-cards">
      <div v-for="row in rows" :key="row.key" class="bulk-card" :class="rowClass(row)">
        <div class="bulk-card-head" @click="toggleExpand(row.key)">
          <div class="bulk-card-thumb">
            <img
              v-if="row.thumb"
              :src="row.thumb"
              class="bulk-thumb"
              :alt="row.fileName"
              @click.stop="previewImg = row.thumb"
            />
            <span v-else-if="row.isPdf" class="bulk-pdf-chip">PDF</span>
            <span v-else class="bulk-thumb-ph"></span>
          </div>
          <div class="bulk-card-summary">
            <div class="bulk-card-line1">
              <span class="bulk-status-badge" :class="`st-${statusBadge(row).tone}`">{{ statusBadge(row).label }}</span>
              <span class="bulk-card-amount">{{ row.amount ? ('$' + row.amount) : '—' }}</span>
            </div>
            <div class="bulk-card-line2">
              <span class="bulk-card-vendor">{{ row.vendor || row.fileName }}</span>
              <span class="bulk-card-date" :class="{ 'date-missing': !row.date }">{{ row.date || 'verify purchase date' }}</span>
            </div>
            <div class="bulk-card-line3">
              <span class="bulk-card-driver" :class="{ 'date-missing': !row.driver }">{{ row.driver || 'no driver' }}</span>
            </div>
          </div>
          <span class="bulk-card-chevron">{{ expanded.has(row.key) ? '▴' : '▾' }}</span>
        </div>

        <div v-if="expanded.has(row.key)" class="bulk-card-body" @click.stop>
          <div class="bulk-card-fields">
            <label class="bulk-field">
              <span class="bulk-field-label">Amount *</span>
              <input v-model="row.amount" type="number" step="0.01" min="0" placeholder="0.00" class="bulk-cell" :class="{ 'cell-error': row.saveStatus === 'invalid' && !(parseFloat(row.amount) > 0) }" :disabled="saving" />
            </label>
            <label class="bulk-field bulk-field-wide">
              <span class="bulk-field-label">Purchase date *</span>
              <input
                v-model="row.date"
                type="date"
                class="bulk-cell"
                :class="{ 'cell-error': row.saveStatus === 'invalid' && !row.date, 'cell-warn': !row.date && row.saveStatus !== 'invalid' }"
                :disabled="saving"
              />
              <span v-if="!row.date" class="cell-hint-warn">Verify the purchase date — it was not read from the receipt.</span>
            </label>
            <label class="bulk-field">
              <span class="bulk-field-label">Type</span>
              <select v-model="row.type" class="bulk-cell" :disabled="saving">
                <option v-for="t in expenseTypes" :key="t" :value="t">{{ t }}</option>
              </select>
            </label>
            <label class="bulk-field">
              <span class="bulk-field-label">Driver *</span>
              <select v-model="row.driver" class="bulk-cell" :class="{ 'cell-error': row.saveStatus === 'invalid' && !row.driver }" :disabled="saving">
                <option value="">Driver…</option>
                <option v-for="d in drivers" :key="d" :value="d">{{ d }}</option>
              </select>
            </label>
            <label class="bulk-field bulk-field-wide">
              <span class="bulk-field-label">Vendor</span>
              <input v-model="row.vendor" type="text" placeholder="Vendor" class="bulk-cell" maxlength="80" :disabled="saving" />
            </label>
            <label class="bulk-field">
              <span class="bulk-field-label">City</span>
              <input v-model="row.city" type="text" placeholder="City" class="bulk-cell" maxlength="60" :disabled="saving" />
            </label>
            <label class="bulk-field">
              <span class="bulk-field-label">State</span>
              <input v-model="row.state" type="text" placeholder="ST" class="bulk-cell bulk-cell-st" maxlength="2" :disabled="saving" @input="row.state = row.state.toUpperCase()" />
            </label>
          </div>
          <div v-if="row.saveError" class="bulk-card-err">{{ row.saveError }}</div>
          <div class="bulk-card-actions">
            <button v-if="row.saveStatus === 'timeout' || row.saveStatus === 'error'" type="button" class="bulk-retry" :disabled="saving || processing" @click="retryRow(row)">Retry</button>
            <button type="button" class="bulk-btn-ghost bulk-clear" :disabled="saving || processing" @click="removeRow(row.key)">Remove</button>
          </div>
        </div>
      </div>
    </div>

    <!-- Save bar -->
    <div v-if="rows.length" class="bulk-savebar">
      <span v-if="anyInvalid" class="bulk-savehint err">Some rows need a driver, amount, or purchase date.</span>
      <span v-else-if="anyNeedsDate" class="bulk-savehint warn">{{ needsDateCount }} need a purchase date verified before saving.</span>
      <span v-else-if="anyTimeout" class="bulk-savehint warn">{{ timeoutCount }} timed out — check All Expenses, then Retry only if not saved.</span>
      <span v-else-if="anyFailed" class="bulk-savehint err">{{ failedCount }} failed to save — retry or remove.</span>
      <span v-else-if="anyDuplicate" class="bulk-savehint info">{{ duplicateCount }} already logged (duplicate) — remove them.</span>
      <span v-else class="bulk-savehint">{{ savableCount }} ready to save.</span>
      <button
        type="button"
        class="bulk-save"
        :disabled="processing || saving || !savableCount"
        @click="saveAll"
      >{{ saving ? 'Saving…' : `Save ${savableCount} expense${savableCount === 1 ? '' : 's'}` }}</button>
    </div>

    <!-- Image preview overlay -->
    <div v-if="previewImg" class="bulk-preview-overlay" @click="previewImg = null">
      <img :src="previewImg" class="bulk-preview-img" alt="Receipt preview" />
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed, watch, onMounted, onUnmounted, nextTick } from 'vue'
import { useApi } from '../../../composables/useApi'
import { useToast } from '../../../composables/useToast'
import { useViewport } from '../../../composables/useViewport'
import { useDocumentScan } from '../../../composables/useDocumentScan'
import { compressImage } from '../../../lib/imageUtils'

const props = defineProps({
  drivers: { type: Array, default: () => [] },
  expenseTypes: { type: Array, default: () => [] },
})
const emit = defineEmits(['saved'])

const api = useApi()
const { show: toast } = useToast()
const { isMobile } = useViewport()
const { scanDocument } = useDocumentScan()

const MAX_BATCH = 25
// PDFs now go to OCR like photos, so this cap is the SCANNER's limit — not a
// limit on what can be attached.
// The OCR endpoint 413s on a photoData string over 8,500,000 chars, so anything
// larger is measured AFTER encoding and simply doesn't get scanned. It is still
// attached to the expense (expense-create accepts far more — the body limit is
// 50 MB), because losing the receipt is worse than losing the auto-fill.
// 6 MiB of source encodes to ~8.39M chars, hence the user-facing label.
const MAX_OCR_PAYLOAD_CHARS = 8_500_000
const MAX_PDF_LABEL = '6 MB'
const OCR_CONCURRENCY = 3 // parallel Gemini reads — modest so the limiter/credits last
const IMG_MAX_EDGE = 1024
// Renderable in an <img> AND accepted by the OCR endpoint.
const OCRABLE_IMAGE_RE = /^data:image\/(jpeg|jpg|png|webp);base64,/i
// Everything the OCR endpoint accepts — images plus PDFs.
const OCRABLE_RE = /^data:(image\/(jpeg|jpg|png|webp)|application\/pdf);base64,/i
// OCR round-trip can be slow on a large photo over office Wi-Fi; give Gemini
// headroom beyond the api default so a slow-but-successful read isn't aborted
// (a client abort surfaces as 'limited'/Retry, masking a read that would land).
const OCR_CLIENT_TIMEOUT_MS = 50000
// Skip persisting a draft this big — server caps at 40 MB, so stay under it.
// A batch that can't be persisted just loses cross-device resume, nothing else.
const MAX_DRAFT_PERSIST_BYTES = 38 * 1024 * 1024

// 'skipped' is no longer produced — PDFs are scanned like photos now. It is kept
// only so a draft saved by an older client still renders a sane label on resume.
const OCR_LABEL = {
  queued: 'Queued', scanning: 'Scanning…', ok: 'Read',
  failed: 'Not read', ocr_off: 'Manual', skipped: 'PDF', limited: 'Retry',
}

// Rows that must NOT be re-sent by Save All: already saved, parked timeouts
// (ambiguous — may have landed), and server-confirmed duplicates (a re-send
// would just 409 again).
const NON_SAVABLE = new Set(['saved', 'timeout', 'duplicate'])

const defaultDriver = ref('')
const rows = ref([])
const processing = ref(false)
const saving = ref(false)
const progress = reactive({ done: 0, total: 0 })
const fileInputRef = ref(null)
const previewImg = ref(null)
const pendingDraft = ref(null)      // fetched server draft awaiting resume/discard
const expanded = reactive(new Set()) // mobile: keys of expanded cards
let rowSeq = 0
let draftTimer = null
let hydrating = false // true while loading a draft, so the load doesn't re-save

const atCapacity = computed(() => rows.value.length >= MAX_BATCH)
const progressPct = computed(() => (progress.total ? Math.round((progress.done / progress.total) * 100) : 0))
// Savable = everything not already saved and not parked awaiting a manual
// decision (timeouts) and not a confirmed duplicate. This is what Save All
// acts on and what the button counts.
const savableCount = computed(() => rows.value.filter(r => !NON_SAVABLE.has(r.saveStatus)).length)
const anyInvalid = computed(() => rows.value.some(r => r.saveStatus === 'invalid'))
const anyFailed = computed(() => rows.value.some(r => r.saveStatus === 'error'))
const failedCount = computed(() => rows.value.filter(r => r.saveStatus === 'error').length)
const anyTimeout = computed(() => rows.value.some(r => r.saveStatus === 'timeout'))
const timeoutCount = computed(() => rows.value.filter(r => r.saveStatus === 'timeout').length)
const anyDuplicate = computed(() => rows.value.some(r => r.saveStatus === 'duplicate'))
const duplicateCount = computed(() => rows.value.filter(r => r.saveStatus === 'duplicate').length)
// A row needs its purchase date verified when OCR couldn't read one (date left
// blank on purpose — see makeRow) and it hasn't been saved yet.
const anyNeedsDate = computed(() => rows.value.some(r => !r.date && r.saveStatus !== 'saved'))
const needsDateCount = computed(() => rows.value.filter(r => !r.date && r.saveStatus !== 'saved').length)

const pendingDraftWhen = computed(() => {
  const ts = pendingDraft.value?.updatedAt
  if (!ts) return ''
  const d = new Date(ts)
  if (isNaN(d.getTime())) return ''
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
})

function isPdfFile(file) {
  return file.type === 'application/pdf' || /\.pdf$/i.test(file.name || '')
}
function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = () => reject(new Error('read failed'))
    reader.readAsDataURL(file)
  })
}

// sha256 of the raw file bytes → used only for in-batch client-side dedup (skip
// re-adding the identical file). The server independently hashes the payload it
// receives and 409s a duplicate insert; these are two layers, not one hash.
// Fails open ('' → not deduped) where SubtleCrypto is unavailable (e.g. non-HTTPS).
async function hashFile(file) {
  try {
    if (!(file instanceof Blob) || !window.crypto?.subtle) return ''
    const buf = await file.arrayBuffer()
    const digest = await window.crypto.subtle.digest('SHA-256', buf)
    return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('')
  } catch {
    return ''
  }
}

function makeRow(file, fileHash = '') {
  return {
    key: `r${rowSeq++}`,
    fileName: file.name || 'receipt',
    _blob: file,
    isPdf: isPdfFile(file),
    thumb: '',
    photoData: '',
    amount: '',
    // Purchase date, NOT upload date: left blank on purpose. OCR fills it from
    // the receipt (processRow); when it can't, the row stays blank + flagged so
    // the admin verifies it (required before save) rather than silently
    // recording today's date.
    date: '',
    type: 'Fuel',
    vendor: '',
    city: '',
    state: '',
    driver: defaultDriver.value,
    confidence: '',
    // OCR-parsed dynamic details ({label,value}[]) — carried through to create
    // like amount/vendor; stays [] until a successful read fills it (processRow).
    receiptDetails: [],
    ocrStatus: 'queued',
    // Why a scan ended where it did — drives the aggregate toast buckets after a
    // batch. 'unsupported' = couldn't be decoded to an OCR-able JPEG (e.g. a HEIC
    // that failed conversion); 'unreadable' = empty processed image.
    ocrReason: '',
    saveStatus: null,
    saveError: '',
    fileHash,
  }
}

// Concurrency-limited runner: at most `size` workers in flight over `items`.
async function runPool(items, worker, size) {
  let i = 0
  const runners = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++
      await worker(items[idx])
    }
  })
  await Promise.all(runners)
}

// Best-effort ScanKit enhance (crop + deskew + flatten lighting) — the exact
// pass the single Log Expense form runs (ExpensesTab.enhanceReceiptPhoto), now
// enabled for bulk so a creased, badly-lit receipt reads as well here as it does
// there. IMAGES ONLY: ScanKit can't rasterize a PDF.
// Every failure is swallowed and the un-enhanced image is returned — ScanKit can
// 503 (disabled), 402 (out of credits) or 429 (rate limit), and none of those
// may cost us the scan.
async function enhanceImage(dataUrl) {
  try {
    const res = await scanDocument(dataUrl, { returnPdf: false, filter: 'flat' })
    const out = res?.data
    return out && OCRABLE_IMAGE_RE.test(out) ? out : dataUrl
  } catch {
    return dataUrl // keep the raw photo
  }
}

// Send row.photoData (image OR PDF — same endpoint, same shape) to Gemini and
// fill the row from the response. Owns the row's final ocrStatus/ocrReason.
async function ocrRow(row) {
  try {
    const data = await api.post('/api/expenses/ocr', { photoData: row.photoData }, { timeout: OCR_CLIENT_TIMEOUT_MS })
    if (data.amount != null) row.amount = String(data.amount)
    // Only a real read sets the date. A blank leaves the row flagged so the
    // recorded date is always the receipt's purchase date, never today.
    if (data.date) row.date = data.date
    if (data.vendor) row.vendor = String(data.vendor).slice(0, 80)
    if (data.city != null) row.city = String(data.city)
    if (data.state != null) row.state = String(data.state).toUpperCase().slice(0, 2)
    if (data.suggestedType && props.expenseTypes.includes(data.suggestedType)) row.type = data.suggestedType
    // Dynamic details ride along unedited (default [] for older/no-key responses).
    row.receiptDetails = Array.isArray(data.details) ? data.details : []
    // A 200 whose every field is null is NOT a read. Reporting it as "Read · low"
    // over a blank line is the "it scanned but filled nothing" complaint — the
    // admin trusts the badge and saves an empty row. Call it what it is.
    // A zero amount counts as a miss too: it can't be saved (save requires
    // amount > 0), so badging it "Read" would be the same lie.
    const gotAmount = data.amount != null && Number(data.amount) > 0
    if (!gotAmount && !data.date && !data.vendor) {
      row.confidence = ''
      row.ocrStatus = 'failed'
      row.ocrReason = 'empty'
      row.saveError = 'Not read — enter manually'
      return
    }
    row.confidence = data.confidence || ''
    row.ocrStatus = 'ok'
  } catch (err) {
    // 503 = OCR disabled server-side → manual entry.
    // 429 (rate-limited) or 0 (client timeout/abort) = transient → "Retry", so
    // the admin knows the receipt is fine and can re-add it, not that it's bad.
    // 413 = over the server's payload cap (only reachable for a file that dodged
    // the pre-read size check) — say so plainly instead of "couldn't be read".
    // Anything else = genuinely couldn't read it.
    const s = err?.status
    if (s === 413) {
      row.ocrStatus = 'failed'
      row.ocrReason = 'too_large'
      // photoData is already attached by the time we call OCR, so the receipt is
      // safe — only the auto-fill was lost. Say that, don't imply a re-upload.
      row.saveError = `Too big to auto-read (${MAX_PDF_LABEL} max) — attached, enter the fields manually.`
      return
    }
    row.ocrStatus = s === 503 ? 'ocr_off' : (s === 429 || s === 0) ? 'limited' : 'failed'
  }
}

async function processRow(row) {
  row.ocrStatus = 'scanning'
  try {
    if (row.isPdf) {
      const dataUrl = await readFileAsDataUrl(row._blob)
      if (!dataUrl) { row.ocrStatus = 'failed'; row.ocrReason = 'unreadable'; return }
      // Normalize the prefix so the server's application/pdf branch always
      // matches even when the browser left the MIME blank.
      row.photoData = String(dataUrl).replace(/^data:[^;]*;base64,/, 'data:application/pdf;base64,')
      // ATTACH FIRST, scan second. Over the OCR cap we skip only the scan — the
      // receipt still rides along with the expense. Returning early here (as an
      // earlier revision did) left the row perfectly savable with photoData ''
      // and booked an expense into the P&L with NO supporting document, which is
      // exactly the silent gap month-end close can't afford.
      if (row.photoData.length > MAX_OCR_PAYLOAD_CHARS) {
        row.ocrStatus = 'failed'
        row.ocrReason = 'too_large'
        row.saveError = `Too big to auto-read (${MAX_PDF_LABEL} max) — attached, enter the fields manually.`
        return
      }
      // No compressImage and no ScanKit pass — neither can rasterize a PDF.
      // Gemini reads the PDF bytes directly off the same endpoint an image uses.
      await ocrRow(row)
      return
    }
    // Shared helper: downscales JPEG/PNG/WEBP and converts iPhone HEIC→JPEG (the
    // fix for blank bulk rows — createImageBitmap can't decode HEIC off Safari).
    const img = await compressImage(row._blob, IMG_MAX_EDGE)
    if (!img) { row.ocrStatus = 'failed'; row.ocrReason = 'unreadable'; return }
    // Always attach the processed image — even a raw fallback — so the receipt
    // is never lost; the expense still saves with the photo for manual review.
    row.photoData = img
    // Only a browser-renderable image gets a thumbnail. A raw HEIC/HEIF fallback
    // can't be drawn in an <img>, so it gets the placeholder instead.
    const isImage = OCRABLE_IMAGE_RE.test(img)
    if (isImage) row.thumb = img
    // A PDF with a blank MIME and no .pdf extension slips past isPdfFile() and
    // lands here; compressImage can't decode it and hands back the raw data URL.
    // It's still perfectly OCR-able — just re-flag it so it renders as a PDF.
    if (!isImage && /^data:application\/pdf;base64,/i.test(img)) row.isPdf = true
    // Anything the OCR endpoint can't take (e.g. an unconverted HEIC) stops here
    // and is flagged for the toast rather than burning a doomed request.
    if (!OCRABLE_RE.test(img)) { row.ocrStatus = 'failed'; row.ocrReason = 'unsupported'; return }
    // Enhance first (images only), then OCR the cleaned-up copy — and keep it as
    // the stored receipt, so what the admin reviews is what Gemini read.
    if (isImage) {
      row.photoData = await enhanceImage(img)
      row.thumb = row.photoData
    }
    await ocrRow(row)
  } catch {
    row.ocrStatus = 'failed'
  } finally {
    row._blob = null // release the File once processed
    progress.done++
  }
}

async function onFilesSelected(event) {
  const picked = Array.from(event.target.files || [])
  if (fileInputRef.value) fileInputRef.value.value = '' // allow re-picking same files
  if (!picked.length) return
  if (!defaultDriver.value) {
    toast('Pick a default driver first', 'error')
    return
  }
  // Client-side dedup: skip any file whose exact bytes are already in the grid
  // (hash of the raw file). Saves a wasted OCR call + a doomed save; the server
  // still independently rejects a duplicate payload with 409.
  const seen = new Set(rows.value.map(r => r.fileHash).filter(Boolean))
  const accepted = []
  let dupSkipped = 0
  for (const f of picked) {
    const h = await hashFile(f)
    if (h && seen.has(h)) { dupSkipped++; continue }
    if (h) seen.add(h)
    accepted.push({ file: f, hash: h })
  }
  if (dupSkipped) toast(`Skipped ${dupSkipped} duplicate receipt${dupSkipped === 1 ? '' : 's'}`, 'error')
  if (!accepted.length) return
  const remaining = MAX_BATCH - rows.value.length
  if (remaining <= 0) {
    toast(`Max ${MAX_BATCH} receipts per batch — save or clear first`, 'error')
    return
  }
  let toAdd = accepted
  if (accepted.length > remaining) {
    toAdd = accepted.slice(0, remaining)
    toast(`Added ${remaining} — ${MAX_BATCH}-receipt limit reached`, 'error')
  }
  const start = rows.value.length
  for (const item of toAdd) rows.value.push(makeRow(item.file, item.hash))
  const added = rows.value.slice(start) // reactive proxies for the new rows
  processing.value = true
  progress.done = 0
  progress.total = added.length
  try {
    await runPool(added, processRow, OCR_CONCURRENCY)
  } finally {
    processing.value = false
  }
  summarizeScan(added)
}

// One toast over a just-processed batch (mirrors the single-form tone in
// ExpensesTab.runAddFormOcr). Its whole reason to exist is to make a silent
// failure loud — chiefly telling the admin that unreadable iPhone HEICs need
// converting to JPEG, rather than leaving them staring at blank rows.
function summarizeScan(batch) {
  if (!batch.length) return
  // `read` counts only rows that actually came back with something — a 200 full
  // of nulls is bucketed as `empty`, not as a scan, so this number matches what
  // the admin sees in the grid.
  const read = batch.filter(r => r.ocrStatus === 'ok').length
  const failedWith = (reason) => batch.filter(r => r.ocrStatus === 'failed' && r.ocrReason === reason).length
  const unsupported = failedWith('unsupported')
  const empty = failedWith('empty')
  const tooLarge = failedWith('too_large')
  const KNOWN = ['unsupported', 'empty', 'too_large']
  const otherFailed = batch.filter(r => r.ocrStatus === 'failed' && !KNOWN.includes(r.ocrReason)).length
  const ocrOff = batch.filter(r => r.ocrStatus === 'ocr_off').length
  const limited = batch.filter(r => r.ocrStatus === 'limited').length
  const parts = [`Scanned ${read} of ${batch.length}`]
  if (empty) parts.push(`${empty} came back blank — enter ${empty === 1 ? 'it' : 'them'} manually`)
  if (unsupported) parts.push(`${unsupported} couldn't be read — convert HEIC to JPEG`)
  // "attached" is the load-bearing word: the receipt IS saved with the expense,
  // only the auto-fill was skipped. Without it this reads as "the file was lost".
  if (tooLarge) parts.push(`${tooLarge} too big to auto-read (${MAX_PDF_LABEL} max) — attached, enter manually`)
  if (otherFailed) parts.push(`${otherFailed} couldn't be read`)
  if (ocrOff) parts.push(`${ocrOff} not scanned — scanning unavailable, enter manually`)
  if (limited) parts.push(`${limited} rate-limited — retry`)
  // Error tone whenever anything but a clean read landed.
  const hasProblem = empty || unsupported || tooLarge || otherFailed || ocrOff || limited
  toast(parts.join(' · '), hasProblem ? 'error' : 'success')
}

function applyDefaultToAll() {
  if (!defaultDriver.value) { toast('Pick a default driver first', 'error'); return }
  for (const r of rows.value) r.driver = defaultDriver.value
}

function removeRow(key) {
  rows.value = rows.value.filter(r => r.key !== key)
  expanded.delete(key)
}

function clearAll() {
  rows.value = []
  expanded.clear()
  clearDraft()
}

function toggleExpand(key) {
  if (expanded.has(key)) expanded.delete(key)
  else expanded.add(key)
}

// Fill blanks when a default is chosen after some rows were already added.
watch(defaultDriver, (val) => {
  if (!val) return
  for (const r of rows.value) if (!r.driver) r.driver = val
})

// ── Server-side draft (cross-device resume) ────────────────────────────────
// Persist only what's needed to rebuild the grid; drop the transient File and,
// for images, the thumb (identical to photoData — rebuilt on load).
function serializeRow(r) {
  return {
    key: r.key,
    fileName: r.fileName,
    isPdf: r.isPdf,
    photoData: r.photoData,
    amount: r.amount,
    date: r.date,
    type: r.type,
    vendor: r.vendor,
    city: r.city,
    state: r.state,
    driver: r.driver,
    confidence: r.confidence,
    receiptDetails: r.receiptDetails || [],
    ocrStatus: r.ocrStatus,
    // A snapshot taken mid-save could catch 'saving' — normalize to pending so a
    // resumed row is savable, never stuck.
    saveStatus: r.saveStatus === 'saving' ? null : r.saveStatus,
    saveError: r.saveError,
    fileHash: r.fileHash,
  }
}

function scheduleDraftSave() {
  if (hydrating || pendingDraft.value) return
  if (draftTimer) clearTimeout(draftTimer)
  draftTimer = setTimeout(saveDraft, 1500)
}

async function saveDraft() {
  draftTimer = null
  if (pendingDraft.value) return // don't overwrite a draft the user hasn't resolved
  const payloadRows = rows.value.filter(r => r.saveStatus !== 'saved').map(serializeRow)
  try {
    if (!payloadRows.length) { await api.del('/api/expenses/bulk-draft'); return }
    const approxBytes = payloadRows.reduce((n, r) => n + (r.photoData ? r.photoData.length : 0) + 300, 0)
    if (approxBytes > MAX_DRAFT_PERSIST_BYTES) {
      console.warn('Bulk draft too large to persist — cross-device resume skipped for this batch')
      return
    }
    await api.put('/api/expenses/bulk-draft', { rows: payloadRows })
  } catch (err) {
    // Draft persistence is a convenience; a failure must never disrupt the flow.
    console.warn('Bulk draft save skipped:', err?.message || err)
  }
}

async function clearDraft() {
  if (draftTimer) { clearTimeout(draftTimer); draftTimer = null }
  try { await api.del('/api/expenses/bulk-draft') } catch (err) { console.warn('Bulk draft clear skipped:', err?.message || err) }
}

function hydrateDraft(draftRows) {
  hydrating = true
  rows.value = (draftRows || []).map(r => ({
    key: `r${rowSeq++}`, // re-key so restored rows never collide with new ones
    fileName: r.fileName || 'receipt',
    _blob: null,
    isPdf: !!r.isPdf,
    // Images stored photoData only; thumb is the same data URL, rebuilt here.
    thumb: r.isPdf ? '' : (r.photoData || ''),
    photoData: r.photoData || '',
    amount: r.amount ?? '',
    date: r.date || '',
    type: r.type || 'Fuel',
    vendor: r.vendor || '',
    city: r.city || '',
    state: r.state || '',
    driver: r.driver || '',
    confidence: r.confidence || '',
    receiptDetails: Array.isArray(r.receiptDetails) ? r.receiptDetails : [],
    ocrStatus: r.ocrStatus || 'queued',
    saveStatus: r.saveStatus === 'saving' ? null : (r.saveStatus || null),
    saveError: r.saveError || '',
    fileHash: r.fileHash || '',
  }))
  // Release the guard after the load-triggered watcher has flushed, so the very
  // first change that re-saves the draft is a genuine user edit.
  nextTick(() => { hydrating = false })
}

function resumeDraft() {
  if (!pendingDraft.value) return
  const dr = pendingDraft.value.rows || []
  pendingDraft.value = null
  hydrateDraft(dr)
  toast(`Resumed ${dr.length} receipt${dr.length === 1 ? '' : 's'}`, 'success')
}

async function discardDraft() {
  pendingDraft.value = null
  await clearDraft()
}

async function saveOne(row) {
  row.saveStatus = 'saving'
  row.saveError = ''
  try {
    // 30s (over the 20s default): a PDF receipt can be ~20MB and up to 3 upload
    // concurrently, so slow office Wi-Fi needs the headroom to avoid a false
    // timeout on a request the server actually completed.
    await api.post('/api/expenses', {
      driver: row.driver,
      type: row.type,
      amount: parseFloat(row.amount),
      date: row.date,
      description: row.description || '',
      vendor: row.vendor || '',
      city: row.city || '',
      state: row.state || '',
      photoData: row.photoData || '',
      // sha256 of the ORIGINAL file. The stored payload is no longer byte-stable
      // (images now go through ScanKit, which silently falls back to the raw image
      // when it's down or out of credits), so hashing the payload alone would let
      // the same receipt back in under a new hash and double-book the P&L.
      sourceHash: row.fileHash || '',
      receiptDetails: row.receiptDetails || [],
      loadId: '',
      gallons: 0,
      odometer: 0,
    }, { timeout: 30000 })
    row.saveStatus = 'saved'
  } catch (err) {
    // 409 DUPLICATE_RECEIPT = the server already has this exact receipt. Park it
    // as 'duplicate' (NOT retryable) so it's flagged, not double-booked.
    if (err?.status === 409 && err?.code === 'DUPLICATE_RECEIPT') {
      row.saveStatus = 'duplicate'
      const existing = err?.data?.existingId
      row.saveError = existing ? `Already logged as expense #${existing}` : 'This receipt was already logged'
    } else if (err?.status === 0) {
      // A timeout/abort (status 0) is AMBIGUOUS — the server may have inserted the
      // row before the response was lost. POST /api/expenses is not idempotent, so
      // a blind retry double-books into the P&L. Park it in a distinct 'timeout'
      // state that is excluded from auto-retry; the admin verifies in All Expenses
      // and consciously hits per-row Retry only if it truly didn't land.
      row.saveStatus = 'timeout'
      row.saveError = 'Timed out — it MAY have saved. Check All Expenses before retrying this row.'
    } else {
      // A normal error (4xx/5xx) means the insert didn't happen, so it stays auto-retryable.
      row.saveStatus = 'error'
      row.saveError = err?.message || 'Failed to save'
    }
  }
}

// Conscious per-row retry for a parked 'timeout' (or 'error') row: reset it to a
// clean savable state so the next Save All picks it up. Deliberately manual so a
// possibly-already-saved row is never resent without the admin's say-so.
function retryRow(row) {
  row.saveStatus = null
  row.saveError = ''
}

async function saveAll() {
  // Exclude already-saved, parked 'timeout', and confirmed 'duplicate' rows —
  // timeouts only re-enter via the conscious per-row Retry (blind resend risks
  // duplicates); a duplicate would just 409 again.
  const pending = rows.value.filter(r => !NON_SAVABLE.has(r.saveStatus))
  // Validate first — mark bad rows, don't send them.
  let invalid = 0
  for (const r of pending) {
    const amt = parseFloat(r.amount)
    if (!r.driver) { r.saveStatus = 'invalid'; r.saveError = 'Pick a driver'; invalid++; if (isMobile.value) expanded.add(r.key); continue }
    if (!amt || amt <= 0) { r.saveStatus = 'invalid'; r.saveError = 'Amount must be > 0'; invalid++; if (isMobile.value) expanded.add(r.key); continue }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r.date || '')) { r.saveStatus = 'invalid'; r.saveError = 'Verify the purchase date'; invalid++; if (isMobile.value) expanded.add(r.key); continue }
    r.saveStatus = null
    r.saveError = ''
  }
  const ready = pending.filter(r => r.saveStatus !== 'invalid')
  if (!ready.length) {
    toast(invalid ? 'Fix the highlighted rows first' : 'Nothing to save', 'error')
    return
  }
  saving.value = true
  try {
    await runPool(ready, saveOne, 3)
  } finally {
    saving.value = false
  }
  const saved = rows.value.filter(r => r.saveStatus === 'saved').length
  const failed = rows.value.filter(r => r.saveStatus === 'error').length
  const timedOut = rows.value.filter(r => r.saveStatus === 'timeout').length
  const dup = rows.value.filter(r => r.saveStatus === 'duplicate').length
  if (saved > 0) emit('saved')
  const parts = [`${saved} saved`]
  if (failed) parts.push(`${failed} failed`)
  if (timedOut) parts.push(`${timedOut} timed out`)
  if (dup) parts.push(`${dup} duplicate`)
  if (invalid) parts.push(`${invalid} need fixing`)
  toast(parts.join(' · '), failed || timedOut || invalid ? 'error' : (dup ? 'error' : 'success'))
  // Drop the saved rows; keep failures/invalids/timeouts/duplicates in the grid.
  rows.value = rows.value.filter(r => r.saveStatus !== 'saved')
  // Persist the remaining state now (or clear the draft if the batch is done)
  // so a device switch right after saving reflects reality.
  saveDraft()
}

function rowClass(row) {
  return {
    'row-saving': row.saveStatus === 'saving',
    'row-error': row.saveStatus === 'error' || row.saveStatus === 'invalid',
    'row-warn': row.saveStatus === 'timeout',
    'row-dup': row.saveStatus === 'duplicate',
    'row-unread': (row.ocrStatus === 'failed' || !row.date) && !row.saveStatus,
  }
}
function ocrTitle(row) {
  if (row.ocrStatus === 'failed') return row.saveError || "Couldn't read this receipt — enter the fields manually"
  if (row.ocrStatus === 'limited') return 'Scan was rate-limited or timed out — the receipt is fine; remove and re-add to retry, or enter manually'
  if (row.ocrStatus === 'ocr_off') return 'Receipt scanning is off — enter the fields manually'
  if (row.ocrStatus === 'skipped') return 'PDF attached — enter the fields manually'
  return ''
}

// Unified per-row status for the mobile card badge: the save state wins once a
// save has been attempted, otherwise fall back to the scan state.
function statusBadge(row) {
  const s = row.saveStatus
  if (s === 'saved') return { label: 'Saved', tone: 'good' }
  if (s === 'saving') return { label: 'Saving…', tone: 'info' }
  if (s === 'duplicate') return { label: 'Duplicate', tone: 'info' }
  if (s === 'timeout') return { label: 'Timed out', tone: 'warn' }
  if (s === 'error') return { label: 'Failed', tone: 'bad' }
  if (s === 'invalid') return { label: 'Needs fix', tone: 'bad' }
  const o = row.ocrStatus
  if (o === 'ok') return { label: 'Read', tone: 'good' }
  if (o === 'scanning') return { label: 'Scanning…', tone: 'neutral' }
  if (o === 'queued') return { label: 'Queued', tone: 'neutral' }
  if (o === 'failed') return { label: 'Not read', tone: 'warn' }
  if (o === 'limited') return { label: 'Retry scan', tone: 'warn' }
  if (o === 'ocr_off') return { label: 'Manual', tone: 'info' }
  if (o === 'skipped') return { label: 'PDF', tone: 'info' }
  return { label: o || '—', tone: 'neutral' }
}

// Auto-save the in-progress batch as the user works (debounced). Deep so a
// field edit (v-model) or a status change schedules a save.
watch(rows, () => scheduleDraftSave(), { deep: true })

onMounted(async () => {
  // On open, offer to resume a batch left in progress on another device/session.
  // The grid starts empty, so a fetched draft is always eligible.
  try {
    const data = await api.get('/api/expenses/bulk-draft')
    const draft = data?.draft
    if (draft && Array.isArray(draft.rows) && draft.rows.length && !rows.value.length) {
      pendingDraft.value = { rows: draft.rows, updatedAt: draft.updatedAt }
    }
  } catch (err) {
    console.warn('Bulk draft check skipped:', err?.message || err)
  }
})

onUnmounted(() => {
  // Flush a pending debounced save so nothing is lost when navigating away.
  if (draftTimer) { clearTimeout(draftTimer); draftTimer = null; saveDraft() }
})
</script>

<style scoped>
.bulk-scan { display: flex; flex-direction: column; gap: 0.85rem; }

.bulk-intro { display: flex; flex-direction: column; gap: 0.25rem; }
.bulk-title { font-size: 1rem; font-weight: 700; color: var(--text); }
.bulk-sub { font-size: 0.8rem; color: var(--text-dim); max-width: 60ch; line-height: 1.45; margin: 0; }

.bulk-resume {
  display: flex; align-items: center; justify-content: space-between; gap: 0.75rem;
  flex-wrap: wrap; padding: 0.75rem 0.9rem; background: var(--blue-dim);
  border: 1px solid var(--blue); border-radius: var(--radius);
}
.bulk-resume-text { display: flex; flex-direction: column; gap: 0.15rem; font-size: 0.82rem; color: var(--text); }
.bulk-resume-text span { color: var(--text-dim); }
.bulk-resume-actions { display: flex; align-items: center; gap: 0.5rem; }
.bulk-resume-yes { padding: 0.45rem 0.9rem; }

.bulk-controls {
  display: flex; flex-wrap: wrap; align-items: flex-end; gap: 0.6rem;
  padding: 0.75rem; background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius);
}
.bulk-control { display: flex; flex-direction: column; gap: 0.3rem; }
.bulk-label { font-size: 0.72rem; color: var(--text-dim); font-weight: 600; }
.bulk-input {
  padding: 0.45rem 0.6rem; background: var(--bg); color: var(--text);
  border: 1px solid var(--border); border-radius: 8px; font-family: inherit; font-size: 0.85rem;
  min-width: 200px;
}

.bulk-add {
  padding: 0.5rem 0.85rem; background: var(--accent); color: #fff; font-weight: 600;
  font-size: 0.82rem; border-radius: 8px; cursor: pointer; user-select: none;
  display: inline-flex; align-items: center; position: relative; overflow: hidden;
}
.bulk-add.disabled { opacity: 0.5; cursor: not-allowed; }
.bulk-file-input { position: absolute; inset: 0; opacity: 0; cursor: pointer; }
.bulk-add.disabled .bulk-file-input { cursor: not-allowed; }

.bulk-btn-ghost {
  padding: 0.45rem 0.7rem; background: transparent; color: var(--text-dim);
  border: 1px solid var(--border); border-radius: 8px; cursor: pointer;
  font-family: inherit; font-size: 0.78rem;
}
.bulk-btn-ghost:hover:not(:disabled) { color: var(--text); border-color: var(--text-dim); }
.bulk-btn-ghost:disabled { opacity: 0.45; cursor: not-allowed; }
.bulk-clear { color: var(--danger); border-color: var(--danger-dim); }
.bulk-count { margin-left: auto; font-size: 0.78rem; color: var(--text-dim); align-self: center; }

.bulk-progress { display: flex; align-items: center; gap: 0.6rem; }
.bulk-progress-bar { flex: 1; height: 6px; background: var(--surface); border-radius: 3px; overflow: hidden; }
.bulk-progress-fill { height: 100%; background: var(--accent); transition: width 0.2s ease; }
.bulk-progress-label { font-size: 0.76rem; color: var(--text-dim); white-space: nowrap; }

.bulk-empty {
  padding: 1.5rem; text-align: center; font-size: 0.85rem; color: var(--text-dim);
  background: var(--surface); border: 1px dashed var(--border); border-radius: var(--radius);
}

.bulk-grid-wrap { overflow-x: auto; border: 1px solid var(--border); border-radius: var(--radius); }
.bulk-grid { width: 100%; border-collapse: collapse; font-size: 0.82rem; min-width: 900px; }
.bulk-grid thead th {
  text-align: left; padding: 0.5rem 0.55rem; font-size: 0.7rem; font-weight: 600;
  color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.03em;
  border-bottom: 1px solid var(--border); background: var(--surface); position: sticky; top: 0;
}
.bulk-grid tbody td { padding: 0.4rem 0.55rem; border-bottom: 1px solid var(--border); vertical-align: middle; }
.bulk-grid tbody tr:last-child td { border-bottom: none; }
.bulk-grid tbody tr.row-saving { opacity: 0.6; }
.bulk-grid tbody tr.row-error { background: var(--danger-dim); }
.bulk-grid tbody tr.row-warn { background: var(--amber-dim); }
.bulk-grid tbody tr.row-unread { background: var(--amber-dim); }
.bulk-grid tbody tr.row-dup { background: var(--blue-dim); }

.col-thumb { width: 52px; }
.col-status { width: 84px; }
.col-amount { width: 100px; }
.col-date { width: 148px; }
.col-type { width: 120px; }
.col-state { width: 56px; }
.col-remove { width: 76px; text-align: center; }

.bulk-thumb { width: 40px; height: 40px; object-fit: cover; border-radius: 5px; cursor: pointer; border: 1px solid var(--border); }
.bulk-thumb-ph { display: inline-block; width: 40px; height: 40px; border-radius: 5px; background: var(--surface); }
.bulk-pdf-chip {
  display: inline-flex; align-items: center; padding: 0.15rem 0.4rem; font-size: 0.68rem;
  font-weight: 700; color: var(--blue); background: var(--blue-dim); border-radius: 5px;
}

.bulk-oc { display: inline-flex; align-items: center; gap: 0.2rem; font-size: 0.7rem; font-weight: 600; padding: 0.15rem 0.4rem; border-radius: 5px; white-space: nowrap; }
.oc-queued, .oc-scanning { color: var(--text-dim); background: var(--surface); }
.oc-ok { color: var(--accent); background: var(--accent-dim); }
.oc-failed { color: var(--danger); background: var(--danger-dim); }
.oc-limited { color: var(--amber); background: var(--amber-dim); }
.oc-ocr_off, .oc-skipped { color: var(--blue); background: var(--blue-dim); }
.oc-conf { font-weight: 400; opacity: 0.8; }

.bulk-cell {
  width: 100%; padding: 0.35rem 0.45rem; background: var(--bg); color: var(--text);
  border: 1px solid var(--border); border-radius: 6px; font-family: inherit; font-size: 0.8rem;
}
.bulk-cell-st { text-transform: uppercase; }
.bulk-cell.cell-error { border-color: var(--danger); }
/* Purchase-date needs verifying (OCR couldn't read one) — amber, not a hard error. */
.bulk-cell.cell-warn { border-color: var(--amber); background: var(--amber-dim); }
.cell-hint-warn { display: block; margin-top: 0.15rem; font-size: 0.64rem; font-weight: 600; color: var(--amber); }

.bulk-cell-actions { display: flex; align-items: center; justify-content: center; gap: 0.25rem; }
.bulk-remove { background: transparent; border: none; color: var(--text-dim); font-size: 1.1rem; line-height: 1; cursor: pointer; padding: 0 0.2rem; }
.bulk-remove:hover:not(:disabled) { color: var(--danger); }
.bulk-remove:disabled { opacity: 0.4; cursor: not-allowed; }
.bulk-retry {
  padding: 0.2rem 0.4rem; font-size: 0.68rem; font-weight: 700; font-family: inherit;
  color: var(--amber); background: var(--amber-dim); border: 1px solid var(--amber);
  border-radius: 5px; cursor: pointer;
}
.bulk-retry:hover:not(:disabled) { opacity: 0.85; }
.bulk-retry:disabled { opacity: 0.4; cursor: not-allowed; }
.bulk-row-msg { font-size: 0.72rem; font-weight: 700; color: var(--text-dim); }
.bulk-row-msg.err { color: var(--danger); }
.bulk-row-msg.dup { color: var(--blue); }

/* ── Mobile cards ───────────────────────────────────────────────────────── */
.bulk-cards { display: flex; flex-direction: column; gap: 0.6rem; }
.bulk-card {
  border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface);
  overflow: hidden;
}
.bulk-card.row-error { border-color: var(--danger); }
.bulk-card.row-warn { border-color: var(--amber); }
.bulk-card.row-dup { border-color: var(--blue); }
.bulk-card.row-unread { border-color: var(--amber); }
.bulk-card.row-saving { opacity: 0.6; }
.bulk-card-head {
  display: flex; align-items: center; gap: 0.6rem; padding: 0.6rem 0.7rem; cursor: pointer;
}
.bulk-card-thumb { flex: 0 0 auto; }
.bulk-card-thumb .bulk-thumb { width: 46px; height: 46px; }
.bulk-card-summary { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 0.2rem; }
.bulk-card-line1 { display: flex; align-items: center; gap: 0.5rem; }
.bulk-card-amount { font-weight: 700; font-size: 0.92rem; color: var(--text); margin-left: auto; }
.bulk-card-line2 { display: flex; align-items: baseline; gap: 0.5rem; justify-content: space-between; }
.bulk-card-vendor { font-size: 0.8rem; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bulk-card-date { font-size: 0.74rem; color: var(--text-dim); white-space: nowrap; }
.bulk-card-line3 { font-size: 0.74rem; color: var(--text-dim); }
.date-missing { color: var(--amber); font-weight: 600; }
.bulk-card-chevron { flex: 0 0 auto; color: var(--text-dim); font-size: 0.8rem; }

.bulk-status-badge {
  display: inline-flex; align-items: center; font-size: 0.66rem; font-weight: 700;
  padding: 0.15rem 0.45rem; border-radius: 999px; text-transform: uppercase; letter-spacing: 0.02em;
  white-space: nowrap;
}
.st-good { color: var(--accent); background: var(--accent-dim); }
.st-info { color: var(--blue); background: var(--blue-dim); }
.st-warn { color: var(--amber); background: var(--amber-dim); }
.st-bad { color: var(--danger); background: var(--danger-dim); }
.st-neutral { color: var(--text-dim); background: var(--bg); }

.bulk-card-body { padding: 0.2rem 0.7rem 0.7rem; border-top: 1px solid var(--border); }
.bulk-card-fields { display: grid; grid-template-columns: 1fr 1fr; gap: 0.55rem; margin-top: 0.6rem; }
.bulk-field { display: flex; flex-direction: column; gap: 0.2rem; }
.bulk-field-wide { grid-column: 1 / -1; }
.bulk-field-label { font-size: 0.68rem; font-weight: 600; color: var(--text-dim); }
.bulk-card-err { margin-top: 0.5rem; font-size: 0.72rem; font-weight: 600; color: var(--danger); }
.bulk-card-actions { display: flex; align-items: center; justify-content: flex-end; gap: 0.5rem; margin-top: 0.6rem; }

.bulk-savebar { display: flex; align-items: center; gap: 0.75rem; justify-content: flex-end; flex-wrap: wrap; }
/* Sits beside the Add control. flex-basis:100% pushes it onto its own line so it
   reads as guidance rather than another toolbar control. */
.bulk-pdf-note {
  flex-basis: 100%;
  margin: 0.15rem 0 0;
  font-size: 0.76rem;
  line-height: 1.4;
  color: var(--text-dim);
}
.bulk-pdf-note strong { color: var(--text); font-weight: 700; }

.bulk-savehint { font-size: 0.78rem; color: var(--text-dim); }
.bulk-savehint.err { color: var(--danger); }
.bulk-savehint.warn { color: var(--amber); }
.bulk-savehint.info { color: var(--blue); }
.bulk-save {
  padding: 0.55rem 1.1rem; background: var(--accent); color: #fff; font-weight: 700;
  font-size: 0.85rem; border: none; border-radius: 8px; cursor: pointer;
}
.bulk-save:disabled { opacity: 0.5; cursor: not-allowed; }

.bulk-preview-overlay {
  position: fixed; inset: 0; background: rgba(0, 0, 0, 0.8); display: flex;
  align-items: center; justify-content: center; z-index: 1000; padding: 2rem; cursor: zoom-out;
}
.bulk-preview-img { max-width: 90vw; max-height: 90vh; border-radius: 8px; }

@media (max-width: 640px) {
  .bulk-input { min-width: 150px; }
  .bulk-count { margin-left: 0; }
  .bulk-savebar { justify-content: stretch; }
  .bulk-save { flex: 1; }
}
</style>
