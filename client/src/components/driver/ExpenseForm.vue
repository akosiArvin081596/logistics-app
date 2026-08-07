<template>
  <van-form @submit="handleSubmit" class="expense-form">
    <van-cell-group inset>
      <div class="form-title">Log Expense</div>

      <van-field
        v-model="form.type"
        is-link
        readonly
        label="Type"
        :placeholder="form.type"
        @click="showTypePicker = true"
      />
      <van-popup v-model:show="showTypePicker" round position="bottom">
        <van-picker
          :columns="typeColumns"
          @cancel="showTypePicker = false"
          @confirm="onTypePick"
        />
      </van-popup>

      <van-field
        v-model="form.amount"
        type="number"
        label="Amount ($)"
        placeholder="0.00"
        :rules="[{ required: true, message: 'Enter amount' }]"
      />

      <van-field
        v-model="form.date"
        type="date"
        label="Date"
        :rules="[{ required: true, message: 'Select date' }]"
      />

      <van-field
        v-model="form.loadId"
        is-link
        readonly
        label="Load"
        :placeholder="form.loadId || 'Select load'"
        :rules="[{ required: true, message: 'Select a load' }]"
        @click="showLoadPicker = true"
      />
      <van-popup v-model:show="showLoadPicker" round position="bottom">
        <van-picker
          :columns="loadColumns"
          @cancel="showLoadPicker = false"
          @confirm="onLoadPick"
        />
      </van-popup>

      <template v-if="form.type === 'Fuel'">
        <van-field
          v-model="form.gallons"
          type="number"
          label="Gallons"
          placeholder="0.0"
        />
        <van-field
          v-model="form.odometer"
          type="number"
          label="Odometer"
          placeholder="Miles"
        />
      </template>

      <van-field
        v-model="form.vendor"
        label="Vendor"
        placeholder="e.g. Pilot Travel Center"
        :maxlength="80"
      />

      <van-field
        v-model="form.description"
        type="textarea"
        label="Description"
        placeholder="Brief description..."
        :maxlength="300"
        show-word-limit
        rows="2"
        autosize
      />

      <van-field v-model="form.city" label="City" placeholder="City" />
      <van-field
        v-model="form.state"
        label="State"
        placeholder="ST"
        :maxlength="2"
        :formatter="(v) => (v || '').toUpperCase()"
        format-trigger="onChange"
      />

      <van-field label="Receipt Photo">
        <template #input>
          <van-uploader
            v-model="fileList"
            :max-count="1"
            :after-read="handlePhoto"
            accept="image/*"
            capture="camera"
            result-type="file"
          />
        </template>
      </van-field>

      <!-- Photo refused before it was ever uploaded. Deliberately a persistent
           block and not a toast: the driver has to DO something about it, and a
           toast is gone before someone at a truck stop has looked up. It sits
           directly under the camera button it is telling them to tap again. -->
      <div v-if="photoError" class="form-alert form-alert-warn" role="alert">
        <div class="form-alert-title">That photo didn&rsquo;t come through</div>
        <div class="form-alert-body">
          Tap the camera above and take it again. If you picked it from your
          photo library, take a fresh photo with the camera instead.
        </div>
        <button type="button" class="form-alert-action" @click="dismissPhotoError">
          Log without a receipt
        </button>
      </div>

      <div v-if="ocrLoading" class="ocr-status ocr-status-loading">
        <span class="ocr-spinner"></span>
        Reading receipt&hellip;
      </div>
      <div v-else-if="ocrApplied" class="ocr-status ocr-status-applied" :class="`ocr-conf-${ocrConfidence || 'medium'}`">
        <span class="ocr-dot"></span>
        Parsed from receipt &middot; please verify the amount
        <button type="button" class="ocr-undo" @click="undoAutofill">Undo autofill</button>
      </div>
    </van-cell-group>

    <!-- Submit failed. The server's own words, because it knows things this form
         cannot (a duplicate receipt, a closed month, a size cap). The heading is
         the part that matters at 2am: everything typed above is still there. -->
    <div v-if="submitError" class="form-alert form-alert-error" role="alert">
      <div class="form-alert-title">Not submitted &mdash; your entry is still here</div>
      <div class="form-alert-body">{{ submitError }}</div>
    </div>

    <div class="form-submit">
      <van-button round block type="primary" native-type="submit" :loading="submitting">
        {{ submitError ? 'Try Again' : 'Submit Expense' }}
      </van-button>
    </div>
  </van-form>
</template>

<script setup>
import { houstonToday } from '../../utils/datetime'
import { ref, reactive, computed } from 'vue'
import { Form as VanForm, Field as VanField, CellGroup as VanCellGroup, Button as VanButton, Uploader as VanUploader, Picker as VanPicker, Popup as VanPopup } from 'vant'
import { useToast } from '../../composables/useToast'
import { useDocumentScan } from '../../composables/useDocumentScan'
import { compressImage, isDecodedImage } from '../../lib/imageUtils'

const props = defineProps({
  loads: { type: Array, default: () => [] },
  driverName: { type: String, required: true },
  headers: { type: Array, default: () => [] },
  // Awaitable submit, mirroring ChatView's `send-handler`. When supplied the
  // form waits for the request, keeps every field on failure, and shows the
  // reason inline beside the retry. The `submit` emit below stays as the legacy
  // fire-and-forget path for any caller not yet moved over.
  submitHandler: { type: Function, default: null },
})

const emit = defineEmits(['submit'])

const toast = useToast()
const { scanDocument } = useDocumentScan()
const submitting = ref(false)
const fileList = ref([])
const photoBase64 = ref('')
const showTypePicker = ref(false)
const showLoadPicker = ref(false)
// A photo was attached and refused, and has not been replaced yet.
const photoError = ref(false)
// Why the last submit failed, in the server's words. Never cleared by a
// refetch or a re-render — only by the next attempt or a new photo.
const submitError = ref('')

const form = reactive({
  type: 'Fuel',
  amount: '',
  date: houstonToday(),
  loadId: '',
  vendor: '',
  description: '',
  city: '',
  state: '',
  gallons: '',
  odometer: '',
})

const typeColumns = [
  { text: 'Fuel', value: 'Fuel' },
  { text: 'Repair', value: 'Repair' },
  { text: 'Maintenance', value: 'Maintenance' },
  { text: 'Wear & Tear', value: 'Wear & Tear' },
  { text: 'Toll', value: 'Toll' },
  { text: 'Food', value: 'Food' },
  { text: 'Other', value: 'Other' },
]

function findCol(headers, regex) {
  return (headers || []).find((h) => regex.test(h)) || null
}

const loadIdOptions = computed(() => {
  const loadIdCol = findCol(props.headers, /load.?id|job.?id/i)
  const statusCol = findCol(props.headers, /status/i)
  if (!loadIdCol) return []
  const completedRe = /^(delivered|completed|pod received|cancelled)$/i
  return props.loads
    .filter((l) => !statusCol || !completedRe.test((l[statusCol] || '').trim()))
    .map((l) => l[loadIdCol])
    .filter(Boolean)
})

const loadColumns = computed(() =>
  loadIdOptions.value.map((id) => ({ text: id, value: id }))
)

function onTypePick({ selectedOptions }) {
  form.type = selectedOptions[0].value
  showTypePicker.value = false
}

function onLoadPick({ selectedOptions }) {
  form.loadId = selectedOptions[0].value
  showLoadPicker.value = false
}

// Snapshot of the form values before OCR prefill so "Undo autofill" can
// restore what the driver had typed.
const preOcrSnapshot = ref(null)
const ocrLoading = ref(false)
const ocrApplied = ref(false)
const ocrConfidence = ref('')
// Dynamic receipt details parsed by OCR ({label,value}[]). Carried straight
// through to create under the same trust model as amount/vendor — no editor UI.
const ocrDetails = ref([])

async function handlePhoto(file) {
  const blob = file && file.file
  if (!blob) return
  photoError.value = false
  submitError.value = ''
  // Decode + downscale to a JPEG data URL via the shared one-pass helper
  // (see imageUtils for the low-RAM OOM fix). Keep the receipt's 1024 max-edge.
  photoBase64.value = await compressImage(blob, 1024)
  // Two failures, one outcome. '' is an unreadable file; a non-JPEG/PNG/WebP
  // data URL is compressImage's raw-bytes fallback, i.e. a file it could not
  // decode at all — an SVG, a mislabelled document, a HEIC even heic2any
  // refused. The server verifies the real magic bytes and 400s that, and the
  // path this replaces booked the expense while silently dropping the receipt.
  // Catch it here, while the driver still has the camera in their hand.
  if (!photoBase64.value || !isDecodedImage(photoBase64.value)) {
    rejectPhoto()
    return
  }
  // Enhance the receipt via ScanKit (crop + flatten lighting) before OCR — a
  // cleaner image improves Gemini's read and is what we store as the receipt.
  // Cover the round-trip with the existing "Reading receipt…" spinner.
  ocrLoading.value = true
  await enhanceReceiptPhoto()
  await runReceiptOcr()
}

// Drop an unusable photo and say so. Emptying fileList matters as much as the
// message: max-count is 1, so a refused file left in the uploader HIDES the
// camera button, and the driver cannot retake without first finding the small
// delete cross on the thumbnail.
function rejectPhoto() {
  photoBase64.value = ''
  fileList.value = []
  photoError.value = true
}

// Conscious override: the driver has read the notice and wants to log the
// expense without a receipt. Same shape as the bulk grid's "Save anyway" — one
// tap, but a person has to take it, so evidence is never dropped by default.
function dismissPhotoError() {
  photoError.value = false
}

// Best-effort receipt enhancement. Any failure (scanning disabled, no credits,
// rate limited, network) keeps the raw compressed photo so OCR + submit still
// work — the driver is never blocked.
async function enhanceReceiptPhoto() {
  if (!photoBase64.value) return
  try {
    const res = await scanDocument(photoBase64.value, { returnPdf: false, filter: 'flat' })
    if (res && res.data) photoBase64.value = res.data
  } catch {
    // Keep the raw photo — enhancement is a nice-to-have, not required.
  }
}

async function runReceiptOcr() {
  if (!photoBase64.value) return
  ocrLoading.value = true
  ocrApplied.value = false
  ocrConfidence.value = ''
  ocrDetails.value = []
  // Snapshot what the driver had entered so we can offer Undo.
  preOcrSnapshot.value = {
    amount: form.amount,
    date: form.date,
    type: form.type,
    vendor: form.vendor,
    description: form.description,
    city: form.city,
    state: form.state,
    gallons: form.gallons,
    odometer: form.odometer,
  }
  try {
    const res = await fetch('/api/expenses/ocr', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ photoData: photoBase64.value }),
    })
    if (res.status === 503) {
      // API key not configured — silent fallback to manual entry.
      preOcrSnapshot.value = null
      return
    }
    if (!res.ok) {
      toast.show('Couldn\'t read receipt — please fill in the fields', 'error')
      preOcrSnapshot.value = null
      return
    }
    const data = await res.json()
    // Prefill non-null fields only. Never override type if the driver already
    // picked something other than the default Fuel.
    if (data.amount != null) form.amount = String(data.amount)
    if (data.date) form.date = data.date
    if (data.vendor) form.vendor = String(data.vendor).slice(0, 80)
    if (data.gallons != null) form.gallons = String(data.gallons)
    if (data.odometer != null) form.odometer = String(data.odometer)
    if (data.city != null) form.city = String(data.city)
    if (data.state != null) form.state = String(data.state).toUpperCase()
    if (data.suggestedType && form.type === 'Fuel') form.type = data.suggestedType
    // Dynamic details ride along unedited (default [] for older/no-key responses).
    ocrDetails.value = Array.isArray(data.details) ? data.details : []
    ocrApplied.value = true
    ocrConfidence.value = data.confidence || ''
  } catch {
    toast.show('Couldn\'t read receipt — please fill in the fields', 'error')
    preOcrSnapshot.value = null
  } finally {
    ocrLoading.value = false
  }
}

function undoAutofill() {
  if (!preOcrSnapshot.value) return
  form.amount = preOcrSnapshot.value.amount
  form.date = preOcrSnapshot.value.date
  form.type = preOcrSnapshot.value.type
  form.vendor = preOcrSnapshot.value.vendor
  form.description = preOcrSnapshot.value.description
  form.city = preOcrSnapshot.value.city
  form.state = preOcrSnapshot.value.state
  form.gallons = preOcrSnapshot.value.gallons
  form.odometer = preOcrSnapshot.value.odometer
  ocrDetails.value = []
  ocrApplied.value = false
}

async function handleSubmit() {
  // The submit button only *looked* guarded before: `submitting` was flipped on
  // and off inside one synchronous block, so it never actually disabled and a
  // double-tap posted twice. POST /api/expenses is not idempotent.
  if (submitting.value) return
  submitError.value = ''

  if (!form.loadId) {
    toast.show('Select a load for this expense', 'error')
    return
  }
  const amount = parseFloat(form.amount)
  if (!amount || amount <= 0) {
    toast.show('Enter a valid amount', 'error')
    return
  }
  // A photo was attached, refused, and not replaced. Submitting now books the
  // expense with no receipt — the same silent evidence loss the byte check
  // exists to stop — so make dropping it a decision rather than a default.
  if (photoError.value) {
    toast.show('Retake the photo, or tap "Log without a receipt"', 'error')
    return
  }

  const payload = {
    driver: props.driverName,
    loadId: form.loadId,
    type: form.type,
    amount: form.amount,
    vendor: form.vendor,
    description: form.description,
    city: form.city,
    state: form.state,
    date: form.date,
    photoData: photoBase64.value,
    gallons: form.gallons || 0,
    odometer: form.odometer || 0,
    receiptDetails: ocrDetails.value,
  }

  // Decided against the list the driver was looking at, not the one that exists
  // after the request: an awaited submit refetches the driver's loads, so
  // `props.loads` can change underneath us before the reset runs.
  const keepLoadId = props.loads.length <= 1

  if (!props.submitHandler) {
    // Legacy fire-and-forget path — the caller owns success/failure, so the
    // form clears optimistically exactly as it always did.
    submitting.value = true
    try {
      emit('submit', payload)
      resetAfterSubmit(keepLoadId)
    } finally {
      submitting.value = false
    }
    return
  }

  submitting.value = true
  try {
    await props.submitHandler(payload)
    // Only now. Clearing before the request is what turned any failure into
    // "lost the amount, the vendor, the gallons, the odometer and the photo".
    resetAfterSubmit(keepLoadId)
  } catch (err) {
    submitError.value = failureText(err)
  } finally {
    submitting.value = false
  }
}

function resetAfterSubmit(keepLoadId) {
  form.amount = ''
  form.vendor = ''
  form.description = ''
  form.city = ''
  form.state = ''
  form.gallons = ''
  form.odometer = ''
  photoBase64.value = ''
  fileList.value = []
  photoError.value = false
  submitError.value = ''
  ocrApplied.value = false
  ocrConfidence.value = ''
  ocrDetails.value = []
  preOcrSnapshot.value = null
  // Keep loadId if only one load (inside load detail)
  if (!keepLoadId) form.loadId = ''
}

// Words that mean "the FILE was the problem". Deliberately excludes "receipt",
// which every message on this endpoint contains — with it in, a closed-period
// 400 ("…this receipt books to August 2026") came back telling the driver to
// retake a photo that was never the issue. Caught in the browser, kept here as
// the reason the list looks arbitrary.
const PHOTO_FAILURE_RE = /image|photo|jpe?g|png|webp|format|file type|data uri/i

// The server's message, verbatim — it is the only thing that knows whether this
// was a duplicate receipt, a closed month, or a file the byte check refused, and
// the bulk-receipt grid surfaces err.message the same way for the same reason.
//
// A next step is appended ONLY when the failure is attributable to the photo: a
// media-type detail tells a driver nothing they can act on, but "take it again"
// does. Matched on the text rather than an error code deliberately — the
// server-side check is landing alongside this, and a wrong code guess would fail
// silently, whereas a missed match here degrades to the verbatim message.
function failureText(err) {
  const msg = (err && err.message) ||
    'Could not submit this expense. Nothing was saved — tap Try Again.'
  const aboutPhoto = err && err.status === 400 && PHOTO_FAILURE_RE.test(msg)
  if (!aboutPhoto) return msg
  // Server messages don't reliably end in punctuation, and without this the two
  // sentences run together into one unreadable line on a phone.
  const stem = /[.!?]$/.test(msg) ? msg : `${msg}.`
  return `${stem} Take the receipt photo again, then submit.`
}
</script>

<style scoped>
.expense-form {
  margin-bottom: 1rem;
}
.form-title {
  font-weight: 600;
  font-size: 0.9rem;
  padding: 0.85rem 1rem 0.5rem;
}
.form-submit {
  padding: 0.75rem;
}
.no-loads-msg {
  text-align: center;
  padding: 2rem 1rem;
  color: var(--text-dim);
  font-size: 0.85rem;
}
.no-loads-msg .empty-icon {
  font-size: 2rem;
  margin-bottom: 0.5rem;
}

.ocr-status {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin: 0.5rem 0.85rem 0.25rem;
  padding: 0.55rem 0.8rem;
  border-radius: 8px;
  font-size: 0.78rem;
  font-weight: 500;
}
.ocr-status-loading {
  background: #eff6ff;
  color: #1e40af;
  border: 1px solid #dbeafe;
}
.ocr-status-applied {
  background: #ecfdf5;
  color: #065f46;
  border: 1px solid #a7f3d0;
}
.ocr-conf-low {
  background: #fffbeb;
  color: #92400e;
  border-color: #fde68a;
}
.ocr-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: currentColor;
  flex-shrink: 0;
}
.ocr-spinner {
  width: 14px;
  height: 14px;
  border: 2px solid rgba(30, 64, 175, 0.25);
  border-top-color: #1e40af;
  border-radius: 50%;
  animation: ocr-spin 0.7s linear infinite;
  flex-shrink: 0;
}
@keyframes ocr-spin { to { transform: rotate(360deg); } }
.ocr-undo {
  margin-left: auto;
  padding: 0.2rem 0.55rem;
  background: transparent;
  border: 1px solid currentColor;
  border-radius: 6px;
  color: inherit;
  font-size: 0.72rem;
  font-weight: 600;
  cursor: pointer;
  font-family: inherit;
}
.ocr-undo:hover {
  opacity: 0.75;
}

/* Blocking notices: a refused photo, and a failed submit. Sized for a phone in
   a cab — full-width, generous line-height, and a tap target that clears 44px. */
.form-alert {
  margin: 0.5rem 0.85rem 0.25rem;
  padding: 0.7rem 0.8rem;
  border-radius: 8px;
  border: 1px solid;
  font-size: 0.8rem;
}
.form-alert-warn {
  background: #fffbeb;
  border-color: #fcd34d;
  color: #78350f;
}
.form-alert-error {
  background: #fef2f2;
  border-color: #fca5a5;
  color: #7f1d1d;
  /* Sits outside the inset cell group, level with the submit button. */
  margin: 0.75rem 0.75rem 0;
}
.form-alert-title {
  font-weight: 700;
  margin-bottom: 0.2rem;
}
.form-alert-body {
  line-height: 1.45;
  /* The server's message can be long and is never truncated — it is the only
     account of what happened. */
  overflow-wrap: anywhere;
}
.form-alert-action {
  display: block;
  margin-top: 0.6rem;
  min-height: 44px;
  padding: 0.5rem 0.9rem;
  background: transparent;
  border: 1px solid currentColor;
  border-radius: 8px;
  color: inherit;
  font-family: inherit;
  font-size: 0.8rem;
  font-weight: 600;
  cursor: pointer;
}
.form-alert-action:hover {
  opacity: 0.75;
}
</style>
