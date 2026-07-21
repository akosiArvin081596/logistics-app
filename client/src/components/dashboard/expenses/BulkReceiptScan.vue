<template>
  <div class="bulk-scan">
    <div class="bulk-intro">
      <div class="bulk-title">Bulk Receipt Upload</div>
      <p class="bulk-sub">
        Pick a driver, drop in a stack of receipts, and each one is scanned into an
        editable row. Review the reads, fix anything off, then save them all as
        expenses. Photos are auto-read; PDFs attach for manual entry.
      </p>
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
          accept="image/*,application/pdf"
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

    <!-- Review grid -->
    <div v-if="rows.length" class="bulk-grid-wrap">
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
              <input v-model="row.date" type="date" class="bulk-cell" :disabled="saving" />
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
                <span v-else-if="row.saveStatus === 'error'" class="bulk-row-msg err" :title="row.saveError">!</span>
                <span v-else-if="row.saveStatus === 'invalid'" class="bulk-row-msg err" :title="row.saveError">fix</span>
                <button type="button" class="bulk-remove" :disabled="saving || processing" aria-label="Remove receipt" @click="removeRow(row.key)">&times;</button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Save bar -->
    <div v-if="rows.length" class="bulk-savebar">
      <span v-if="anyInvalid" class="bulk-savehint err">Some rows need a driver, amount, or date.</span>
      <span v-else-if="anyTimeout" class="bulk-savehint warn">{{ timeoutCount }} timed out — check All Expenses, then Retry only if not saved.</span>
      <span v-else-if="anyFailed" class="bulk-savehint err">{{ failedCount }} failed to save — retry or remove.</span>
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
import { ref, reactive, computed, watch } from 'vue'
import { useApi } from '../../../composables/useApi'
import { useToast } from '../../../composables/useToast'

const props = defineProps({
  drivers: { type: Array, default: () => [] },
  expenseTypes: { type: Array, default: () => [] },
})
const emit = defineEmits(['saved'])

const api = useApi()
const { show: toast } = useToast()

const MAX_BATCH = 25
const MAX_PDF_FILE_BYTES = 15 * 1024 * 1024 // matches the server-side cap
const OCR_CONCURRENCY = 3 // parallel Gemini reads — modest so the limiter/credits last
const IMG_MAX_EDGE = 1024

const OCR_LABEL = {
  queued: 'Queued', scanning: 'Scanning…', ok: 'Read',
  failed: 'Not read', ocr_off: 'Manual', skipped: 'PDF', limited: 'Retry',
}

const defaultDriver = ref('')
const rows = ref([])
const processing = ref(false)
const saving = ref(false)
const progress = reactive({ done: 0, total: 0 })
const fileInputRef = ref(null)
const previewImg = ref(null)
let rowSeq = 0

const atCapacity = computed(() => rows.value.length >= MAX_BATCH)
const progressPct = computed(() => (progress.total ? Math.round((progress.done / progress.total) * 100) : 0))
// Savable = everything not already saved and not parked awaiting a manual
// decision (timeout rows). This is what Save All acts on and what the button counts.
const savableCount = computed(() => rows.value.filter(r => r.saveStatus !== 'saved' && r.saveStatus !== 'timeout').length)
const anyInvalid = computed(() => rows.value.some(r => r.saveStatus === 'invalid'))
const anyFailed = computed(() => rows.value.some(r => r.saveStatus === 'error'))
const failedCount = computed(() => rows.value.filter(r => r.saveStatus === 'error').length)
const anyTimeout = computed(() => rows.value.some(r => r.saveStatus === 'timeout'))
const timeoutCount = computed(() => rows.value.filter(r => r.saveStatus === 'timeout').length)

function todayIso() {
  // Local calendar day (en-CA yields YYYY-MM-DD) — NOT toISOString(), which is
  // UTC and rolls to "tomorrow" in the evening across US zones. Matches the
  // driver ExpenseForm. OCR overrides this on a good read; PDFs/misreads keep it.
  return new Date().toLocaleDateString('en-CA')
}
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

// Decode + downscale in one createImageBitmap pass so a 12MP photo never
// materializes ~48MB of raw RGBA (same OOM defense as ExpenseForm/ExpensesTab).
async function downscaleImage(blob) {
  try {
    const probe = await createImageBitmap(blob)
    let w = probe.width, h = probe.height
    probe.close()
    if (w > IMG_MAX_EDGE || h > IMG_MAX_EDGE) {
      if (w > h) { h = Math.round((h * IMG_MAX_EDGE) / w); w = IMG_MAX_EDGE }
      else { w = Math.round((w * IMG_MAX_EDGE) / h); h = IMG_MAX_EDGE }
    }
    const bitmap = await createImageBitmap(blob, { resizeWidth: w, resizeHeight: h, resizeQuality: 'medium' })
    const canvas = document.createElement('canvas')
    canvas.width = w; canvas.height = h
    canvas.getContext('2d').drawImage(bitmap, 0, 0)
    bitmap.close()
    const url = canvas.toDataURL('image/jpeg', 0.8)
    canvas.width = 0; canvas.height = 0
    return url
  } catch {
    return ''
  }
}

function makeRow(file) {
  return {
    key: `r${rowSeq++}`,
    fileName: file.name || 'receipt',
    _blob: file,
    isPdf: isPdfFile(file),
    thumb: '',
    photoData: '',
    amount: '',
    date: todayIso(),
    type: 'Fuel',
    vendor: '',
    city: '',
    state: '',
    driver: defaultDriver.value,
    confidence: '',
    ocrStatus: 'queued',
    saveStatus: null,
    saveError: '',
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

async function processRow(row) {
  row.ocrStatus = 'scanning'
  try {
    if (row.isPdf) {
      if (row._blob.size > MAX_PDF_FILE_BYTES) {
        row.ocrStatus = 'failed'
        row.saveError = 'PDF over 15 MB'
        return
      }
      const dataUrl = await readFileAsDataUrl(row._blob)
      // Normalize the prefix so the server's application/pdf branch always
      // matches even when the browser left the MIME blank.
      row.photoData = String(dataUrl).replace(/^data:[^;]*;base64,/, 'data:application/pdf;base64,')
      row.ocrStatus = 'skipped' // no OCR for PDFs — manual entry
      return
    }
    const img = await downscaleImage(row._blob)
    if (!img) { row.ocrStatus = 'failed'; return }
    row.thumb = img
    row.photoData = img
    // Bulk skips the ScanKit enhance pass the single forms do — one OCR call per
    // receipt keeps credit spend and the rate limiter in check. Gemini reads raw
    // downscaled photos fine; the admin fixes any misreads in the grid.
    try {
      const data = await api.post('/api/expenses/ocr', { photoData: img }, { timeout: 30000 })
      if (data.amount != null) row.amount = String(data.amount)
      if (data.date) row.date = data.date
      if (data.vendor) row.vendor = String(data.vendor).slice(0, 80)
      if (data.city != null) row.city = String(data.city)
      if (data.state != null) row.state = String(data.state).toUpperCase().slice(0, 2)
      if (data.suggestedType && props.expenseTypes.includes(data.suggestedType)) row.type = data.suggestedType
      row.confidence = data.confidence || ''
      row.ocrStatus = 'ok'
    } catch (err) {
      // 503 = OCR disabled server-side → manual entry.
      // 429 (rate-limited) or 0 (client timeout/abort) = transient → "Retry", so
      // the admin knows the receipt is fine and can re-add it, not that it's bad.
      // Anything else = genuinely couldn't read it.
      const s = err?.status
      row.ocrStatus = s === 503 ? 'ocr_off' : (s === 429 || s === 0) ? 'limited' : 'failed'
    }
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
  const remaining = MAX_BATCH - rows.value.length
  if (remaining <= 0) {
    toast(`Max ${MAX_BATCH} receipts per batch — save or clear first`, 'error')
    return
  }
  let files = picked
  if (picked.length > remaining) {
    files = picked.slice(0, remaining)
    toast(`Added ${remaining} — ${MAX_BATCH}-receipt limit reached`, 'error')
  }
  const start = rows.value.length
  for (const f of files) rows.value.push(makeRow(f))
  const added = rows.value.slice(start) // reactive proxies for the new rows
  processing.value = true
  progress.done = 0
  progress.total = added.length
  try {
    await runPool(added, processRow, OCR_CONCURRENCY)
  } finally {
    processing.value = false
  }
}

function applyDefaultToAll() {
  if (!defaultDriver.value) { toast('Pick a default driver first', 'error'); return }
  for (const r of rows.value) r.driver = defaultDriver.value
}

function removeRow(key) {
  rows.value = rows.value.filter(r => r.key !== key)
}

function clearAll() {
  rows.value = []
}

// Fill blanks when a default is chosen after some rows were already added.
watch(defaultDriver, (val) => {
  if (!val) return
  for (const r of rows.value) if (!r.driver) r.driver = val
})

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
      loadId: '',
      gallons: 0,
      odometer: 0,
    }, { timeout: 30000 })
    row.saveStatus = 'saved'
  } catch (err) {
    // A timeout/abort (status 0) is AMBIGUOUS — the server may have inserted the
    // row before the response was lost. POST /api/expenses is not idempotent, so
    // a blind retry double-books into the P&L. Park it in a distinct 'timeout'
    // state that is excluded from auto-retry; the admin verifies in All Expenses
    // and consciously hits per-row Retry only if it truly didn't land. A normal
    // error (4xx/5xx) means the insert didn't happen, so it stays auto-retryable.
    if (err?.status === 0) {
      row.saveStatus = 'timeout'
      row.saveError = 'Timed out — it MAY have saved. Check All Expenses before retrying this row.'
    } else {
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
  // Exclude already-saved and parked 'timeout' rows — timeouts only re-enter via
  // the conscious per-row Retry, never a blind Save All (would risk duplicates).
  const pending = rows.value.filter(r => r.saveStatus !== 'saved' && r.saveStatus !== 'timeout')
  // Validate first — mark bad rows, don't send them.
  let invalid = 0
  for (const r of pending) {
    const amt = parseFloat(r.amount)
    if (!r.driver) { r.saveStatus = 'invalid'; r.saveError = 'Pick a driver'; invalid++; continue }
    if (!amt || amt <= 0) { r.saveStatus = 'invalid'; r.saveError = 'Amount must be > 0'; invalid++; continue }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r.date || '')) { r.saveStatus = 'invalid'; r.saveError = 'Date required'; invalid++; continue }
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
  if (saved > 0) emit('saved')
  const parts = [`${saved} saved`]
  if (failed) parts.push(`${failed} failed`)
  if (timedOut) parts.push(`${timedOut} timed out`)
  if (invalid) parts.push(`${invalid} need fixing`)
  toast(parts.join(' · '), failed || timedOut || invalid ? 'error' : 'success')
  // Drop the saved rows; keep failures/invalids in the grid for correction.
  rows.value = rows.value.filter(r => r.saveStatus !== 'saved')
}

function rowClass(row) {
  return {
    'row-saving': row.saveStatus === 'saving',
    'row-error': row.saveStatus === 'error' || row.saveStatus === 'invalid',
    'row-warn': row.saveStatus === 'timeout',
    'row-unread': row.ocrStatus === 'failed' && !row.saveStatus,
  }
}
function ocrTitle(row) {
  if (row.ocrStatus === 'failed') return row.saveError || "Couldn't read this receipt — enter the fields manually"
  if (row.ocrStatus === 'limited') return 'Scan was rate-limited or timed out — the receipt is fine; remove and re-add to retry, or enter manually'
  if (row.ocrStatus === 'ocr_off') return 'Receipt scanning is off — enter the fields manually'
  if (row.ocrStatus === 'skipped') return 'PDF attached — enter the fields manually'
  return ''
}
</script>

<style scoped>
.bulk-scan { display: flex; flex-direction: column; gap: 0.85rem; }

.bulk-intro { display: flex; flex-direction: column; gap: 0.25rem; }
.bulk-title { font-size: 1rem; font-weight: 700; color: var(--text); }
.bulk-sub { font-size: 0.8rem; color: var(--text-dim); max-width: 60ch; line-height: 1.45; margin: 0; }

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

.bulk-savebar { display: flex; align-items: center; gap: 0.75rem; justify-content: flex-end; }
.bulk-savehint { font-size: 0.78rem; color: var(--text-dim); }
.bulk-savehint.err { color: var(--danger); }
.bulk-savehint.warn { color: var(--amber); }
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
}
</style>
