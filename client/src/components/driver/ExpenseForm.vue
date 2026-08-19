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

      <!-- A date far from today is almost always a misread year or a fuel-desk
           printer with a wrong clock, and both file the money in a month that
           isn't in the books. Ported from the admin form (ExpensesTab) so the
           two agree. It WARNS and never blocks: a confidently wrong date is
           worse than a blank one, but a driver logging a genuinely old receipt
           must still be able to log it. role="status", not "alert" — it is
           advice about a field, not a failure. -->
      <div v-if="dateSuspect" class="form-alert form-alert-warn" role="status" aria-live="polite">
        <div class="form-alert-title">Does this date look right?</div>
        <div class="form-alert-body">{{ dateSuspect }}</div>
      </div>

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

      <!-- The whole "Receipt Photo" row is a drop target for desktop — drivers
           do open the portal on a laptop. v-bind adds only drag listeners (they
           fall through onto van-field's root cell), so the row's DOM and Vant's
           own cell hairline are unchanged; a wrapper <div> would have made this
           cell :last-child and silently dropped that border.

           ⚠️ The Vant uploader below is untouched ON PURPOSE. Camera capture,
           the file result type, the single-file count, the thumbnail and the
           delete cross are all its behaviours, and rejectPhoto() re-reveals the
           camera button by emptying fileList. Drop is a second way in, no
           more — it never replaces the widget. -->
      <van-field
        label="Receipt Photo"
        :class="{ 'receipt-drop-over': dragActive }"
        v-bind="receiptDropProps"
      >
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

    <!-- POSSIBLE_DUPLICATE: same driver, same day, same amount. Strong, but a
         driver CAN fuel twice at one stop, so this is a QUESTION, not a verdict
         — and the answer is the driver's, not ours.

         ⚠️ The photo and every field are still here, untouched. That is the
         whole point: this form used to clear itself the moment it submitted, so
         a 409 would have stranded the driver AND destroyed the receipt with no
         way to re-file it. -->
    <div
      v-if="duplicateWarning"
      ref="decisionEl"
      class="form-alert form-alert-warn form-alert-outer"
      role="alert"
    >
      <div class="form-alert-title">Is this the same purchase?</div>
      <div class="form-alert-body">
        <template v-if="duplicateSummary">
          This looks like one we already have &mdash; {{ duplicateSummary }}.
        </template>
        <template v-else>{{ duplicateWarning.message }}</template>
      </div>
      <div class="form-alert-body form-alert-note">
        Nothing has been lost &mdash; your photo and everything you typed is still
        here. If you bought twice, log both.
      </div>
      <div class="form-alert-actions">
        <van-button
          round
          block
          size="small"
          type="warning"
          native-type="button"
          :loading="submitting"
          @click="confirmDuplicate"
        >
          Yes &mdash; two separate purchases
        </van-button>
        <van-button
          round
          block
          size="small"
          native-type="button"
          :disabled="submitting"
          @click="discardDuplicate"
        >
          No &mdash; it&rsquo;s already logged
        </van-button>
      </div>
    </div>

    <!-- DUPLICATE_RECEIPT: byte-identical to a receipt already on file. There is
         no server-side override for this one, so it is a statement, not a
         question — say so plainly, name the expense, and offer the one action
         that exists. The entry stays put until the driver clears it. -->
    <div
      v-else-if="alreadyLogged"
      ref="decisionEl"
      class="form-alert form-alert-error form-alert-outer"
      role="alert"
    >
      <div class="form-alert-title">This receipt is already logged</div>
      <div class="form-alert-body">
        <template v-if="alreadyLogged.existingId">
          The same receipt photo is already on file as expense
          #{{ alreadyLogged.existingId }}.
        </template>
        <template v-else>{{ alreadyLogged.message }}</template>
        Nothing is missing and there is nothing to re-send.
      </div>
      <div class="form-alert-actions">
        <van-button round block size="small" native-type="button" @click="clearAlreadyLogged">
          Clear this entry
        </van-button>
      </div>
    </div>

    <!-- Saved, but into a different month than its date implies, because its own
         month is already closed. Not an error and nothing needs correcting — but
         a driver who files a $400 fuel receipt has to be told where the money
         landed. Persistent, not a toast: a driver puts the phone down. -->
    <div v-if="postedNote" class="form-alert form-alert-info form-alert-outer" role="status" aria-live="polite">
      <div class="form-alert-title">{{ postedNote.heading }}</div>
      <div class="form-alert-body">{{ postedNote.body }}</div>
      <div class="form-alert-actions">
        <van-button round block size="small" native-type="button" @click="postedNote = null">
          Got it
        </van-button>
      </div>
    </div>

    <!-- Hidden while a duplicate decision is open: the two real choices are the
         buttons above, and re-tapping Submit would only earn the same 409. What
         makes that safe is that BOTH states have an explicit exit button — that
         is the whole guarantee, and it is the one to preserve. Editing a keyed
         field additionally withdraws the POSSIBLE_DUPLICATE question by itself
         (the watcher below clears `duplicateWarning` only); `alreadyLogged` is a
         statement, not a question, and is cleared solely by its own button. -->

    <div v-if="!decisionPending" class="form-submit">
      <van-button round block type="primary" native-type="submit" :loading="submitting">
        {{ submitError ? 'Try Again' : 'Submit Expense' }}
      </van-button>
    </div>
  </van-form>
</template>

<script setup>
import { houstonToday, fmtYmd } from '../../utils/datetime'
import { ref, reactive, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import { Form as VanForm, Field as VanField, CellGroup as VanCellGroup, Button as VanButton, Uploader as VanUploader, Picker as VanPicker, Popup as VanPopup } from 'vant'
import { useToast } from '../../composables/useToast'
import { useDocumentScan } from '../../composables/useDocumentScan'
import { useFileDrop } from '../../composables/useFileDrop'
import { compressImage, isDecodedImage } from '../../lib/imageUtils'
// "2026-06" -> "June 2026". Shared, not local: the copy that used to live here
// was one of several, and two of them under one name in client/src/lib/ had
// OPPOSITE failure behaviour. This one returns '' when it cannot read the key,
// which is what notePostedPeriod()'s `if (!posted) return` depends on.
import { monthLabel } from '../../lib/monthLabel'

const props = defineProps({
  loads: { type: Array, default: () => [] },
  driverName: { type: String, required: true },
  headers: { type: Array, default: () => [] },
  // Awaitable submit, mirroring ChatView's `send-handler`. When supplied the
  // form waits for the request, keeps every field on failure, and shows the
  // reason inline beside the retry. The `submit` emit below stays as the legacy
  // fire-and-forget path for any caller not yet moved over.
  //
  // ⚠️ CONTRACT: it must RETURN the server's response body. That body is the
  // only place the server says it booked the money to a different month than
  // the receipt's date (see notePostedPeriod), and a handler that awaits
  // without returning silently withholds it — no error, just no note.
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

// ── Duplicate outcomes ──────────────────────────────────────────────────────
// Two different 409s, and the difference matters to the driver:
//
//   POSSIBLE_DUPLICATE  same driver + day + amount. Overridable — a driver can
//                       genuinely fuel twice at one stop — so it is a QUESTION,
//                       answered by `allowDuplicate: true`.
//   DUPLICATE_RECEIPT   byte-identical receipt. No server-side override exists,
//                       so it is a STATEMENT: already logged, here is the id.
//
// Neither clears the form. `resetAfterSubmit` runs on success ONLY, so the
// photo, the amount, the gallons and the odometer all survive a 409 — the
// failure mode that kept this check opt-in in the first place.
const duplicateWarning = ref(null) // { message, existingId, existing, keepLoadId }
const alreadyLogged = ref(null)    // { message, existingId, keepLoadId }
// A decision the driver owns is on screen. Suppresses the main submit button so
// the only ways forward are the explicit answers.
const decisionPending = computed(() => !!duplicateWarning.value || !!alreadyLogged.value)
const decisionEl = ref(null)

// The expense was saved, but booked into a different month than its date implies
// (its own month is already closed). { heading, body }, or null.
const postedNote = ref(null)

// Drop straight onto the Receipt Photo row. One file, matching :max-count="1";
// the HEIC/HEIF extensions are there because every non-Safari browser leaves
// file.type blank for an iPhone photo, so MIME alone would refuse the format
// this form receives most (compressImage converts it downstream).
// A refusal is a toast, not the photoError block: that block's copy is "tap the
// camera and take it again", which is the wrong instruction for "you dropped a
// PDF", and nothing was attached so there is no state to unwind.
const { dropzoneProps, dragActive, error: dropError, clearMessages: clearDropError } = useFileDrop({
  accept: 'image/*,.heic,.heif',
  maxSizeMb: 20,
  // handlePhoto's argument is Vant's after-read wrapper. Hand it that exact
  // shape rather than widening the signature — Vant is its other caller.
  onFiles: (files) => handlePhoto({ file: files[0] }),
})

// ⚠️ Watched on the `error` REF, not through onReject: a dropped FOLDER is
// caught before validation runs and never reaches onReject, so rejections alone
// would leave the commonest mis-drop silent.
watch(dropError, (msg) => {
  if (!msg) return
  toast.show(msg, 'error')
  clearDropError()
})

// ⚠️ Vant's uploader paints its own bare <input type="file"> across the "+"
// tile, and a drop that lands ON that input is handled natively — that is what
// produces the thumbnail and fires after-read. preventDefault()ing it from an
// ancestor would cancel the input's default action and silently swallow a drop
// that visibly landed on it (the same trap useFileDrop's window guard calls
// out), so the input keeps first refusal and this only covers the rest of the
// row. The highlight still clears either way: the window-level drop listener
// resets every zone's drag depth.
const receiptDropProps = computed(() => {
  const base = dropzoneProps.value
  return {
    ...base,
    onDrop: (e) => {
      if (e.target?.closest?.('input[type="file"]')) return
      base.onDrop(e)
    },
  }
})

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

// ── Date hygiene ────────────────────────────────────────────────────────────
// The expense date decides which MONTH the money lands in, and both ways of
// getting it wrong here were silent.
//
// (1) `houstonToday()` is read once, at component creation. The driver app is a
//     phone screen that stays open for hours, so a form opened at 11 PM still
//     offers YESTERDAY at 12:05 AM — and at month end that is a different
//     period entirely. `defaultedDate` tracks the value THIS form put in the
//     field so a still-untouched default can be refreshed; the moment a driver
//     (or the receipt OCR) sets a date, it is theirs and is never overwritten.
// (2) `resetAfterSubmit` never cleared the date, so an OCR'd 2025 receipt left
//     its date on the NEXT expense with no cue at all.
const defaultedDate = ref(form.date)
const dateTouched = ref(false)
watch(
  () => form.date,
  (v) => {
    if (v !== defaultedDate.value) dateTouched.value = true
  },
)

// True while nothing has been entered — no amount, no photo, no OCR. Only then
// may the default date be moved: the alternative (refreshing it whenever the app
// comes back to the foreground) would silently re-date a receipt the driver
// started typing at 11:58 PM, which is the same wrong-month bug pointed the
// other way.
function isPristineEntry() {
  return (
    !form.amount && !form.vendor && !form.description && !form.city && !form.state &&
    !form.gallons && !form.odometer && !photoBase64.value && !ocrApplied.value && !photoError.value
  )
}

function refreshDefaultDate() {
  if (dateTouched.value || !isPristineEntry()) return
  const today = houstonToday()
  if (today === form.date) return
  // Set the guard BEFORE the field: the watcher above compares against it, so
  // this assignment must not read as the driver typing.
  defaultedDate.value = today
  form.date = today
}

function onVisibilityChange() {
  if (document.visibilityState === 'visible') refreshDefaultDate()
}
onMounted(() => document.addEventListener('visibilitychange', onVisibilityChange))
onBeforeUnmount(() => document.removeEventListener('visibilitychange', onVisibilityChange))

// Ported from ExpensesTab's `addDateSuspect` so the driver form and the admin
// form judge a date the same way.
//
// ⚠️ ASYMMETRIC, not ±120 days, and deliberately so: a receipt cannot be from
// tomorrow (1 day of slack covers a timezone edge), but it can legitimately be
// four months old. Warns and never blocks.
const DATE_STALE_DAYS = 120
const dateSuspect = computed(() => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(form.date || '')
  if (!m) return ''
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  if (isNaN(d)) return ''
  const days = (Date.now() - d.getTime()) / 86400000
  if (days < -1) return 'This is dated in the future — check the date.'
  if (days <= DATE_STALE_DAYS) return ''
  return Number(m[1]) === new Date().getFullYear()
    ? 'This is over 4 months old — check the date.'
    : `This is dated ${m[1]} — check the year before saving.`
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
  // A new receipt is a new question. In particular DUPLICATE_RECEIPT is keyed on
  // the bytes, so replacing the photo is one of the two ways out of it.
  duplicateWarning.value = null
  alreadyLogged.value = null
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
      // Bypasses useApi, so it carries the CSRF header itself — see useApi.js.
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
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
  // Each of these describes the PREVIOUS attempt. Clearing them here (and only
  // here) is what keeps the posted-month note on screen after a successful
  // submit — resetAfterSubmit deliberately leaves it alone.
  duplicateWarning.value = null
  alreadyLogged.value = null
  postedNote.value = null

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

  const payload = buildPayload()

  // Decided against the list the driver was looking at, not the one that exists
  // after the request: an awaited submit refetches the driver's loads, so
  // `props.loads` can change underneath us before the reset runs.
  const keepLoadId = props.loads.length <= 1

  if (!props.submitHandler) {
    // Legacy fire-and-forget path — the caller owns success/failure, so the
    // form clears optimistically exactly as it always did.
    //
    // ⚠️ Nothing reaches this today (DriverView and LoadDetail both inject a
    // handler, and no one listens to the `submit` emit) — and it must stay that
    // way. A caller that fires and forgets cannot show the duplicate question, so
    // a 409 here clears the form and DESTROYS THE RECEIPT: exactly the failure
    // that kept the server-side check opt-in for as long as it was opt-in.
    //
    // The condition is stronger than an earlier version of this comment claimed.
    // It said this had to hold "while stores/driver.js sends checkDuplicate: true",
    // which read as though removing a flag would make this path safe again. It
    // never would have: the server now runs the duplicate check UNCONDITIONALLY
    // (`wantsDuplicateCheck = req.body?.allowDuplicate !== true`) and there is no
    // flag to remove — every caller gets the 409, so a fire-and-forget caller eats
    // an unhandleable one no matter what it sends. Wire a new caller to
    // `submit-handler`, not this.
    submitting.value = true
    try {
      emit('submit', payload)
      resetAfterSubmit(keepLoadId)
    } finally {
      submitting.value = false
    }
    return
  }

  await sendExpense(payload, keepLoadId)
}

// One place the request body is built, so the duplicate re-submit sends exactly
// what the first attempt sent plus the driver's answer — never a second,
// drifting copy of the field mapping.
function buildPayload(extra) {
  return {
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
    ...(extra || {}),
  }
}

async function sendExpense(payload, keepLoadId) {
  submitting.value = true
  try {
    const res = await props.submitHandler(payload)
    // Only now. Clearing before the request is what turned any failure into
    // "lost the amount, the vendor, the gallons, the odometer and the photo".
    resetAfterSubmit(keepLoadId)
    notePostedPeriod(res)
  } catch (err) {
    handleSubmitFailure(err, keepLoadId)
  } finally {
    submitting.value = false
  }
}

// Route the failure. A duplicate is not an error the driver should have to read
// a server sentence about and then re-type an expense over — it is a question
// (or, for an identical receipt, a fact), and both keep everything on screen.
function handleSubmitFailure(err, keepLoadId) {
  if (err && err.status === 409 && err.code === 'POSSIBLE_DUPLICATE') {
    duplicateWarning.value = {
      message: err.message || '',
      existingId: (err.data && err.data.existingId) || null,
      existing: (err.data && err.data.existing) || null,
      keepLoadId,
    }
    revealDecision()
    return
  }
  if (err && err.status === 409 && err.code === 'DUPLICATE_RECEIPT') {
    alreadyLogged.value = {
      message: err.message || 'This receipt was already logged.',
      existingId: (err.data && err.data.existingId) || null,
      keepLoadId,
    }
    revealDecision()
    return
  }
  submitError.value = failureText(err)
}

// The question replaces the submit button the driver just tapped, and on a long
// form in a cab that can land off-screen. Bring it to them.
function revealDecision() {
  nextTick(() => {
    decisionEl.value?.scrollIntoView?.({ block: 'center', behavior: 'smooth' })
  })
}

// What the server already has, in the driver's terms — enough to hold against
// the paper in their hand. Always the EXISTING row's merchant, never the one
// just typed: the whole reason this check fires without a merchant match is that
// the two sides often disagree, and printing ours would describe a row that
// doesn't exist.
const duplicateSummary = computed(() => {
  const w = duplicateWarning.value
  const e = w && w.existing
  if (!e) return ''
  const id = e.id != null ? e.id : w.existingId
  const amount = Number(e.amount)
  const parts = [
    id != null ? `expense #${id}` : '',
    e.vendor || 'no merchant recorded',
    fmtYmd(e.date, { fallback: '' }),
    Number.isFinite(amount) ? `$${amount.toFixed(2)}` : '',
  ].filter(Boolean)
  return parts.join(' · ')
})

// "Yes — two separate purchases." The one conscious override, carried on the
// payload the driver just confirmed and never sticky: the next expense is
// checked again from scratch.
async function confirmDuplicate() {
  if (!duplicateWarning.value || submitting.value || !props.submitHandler) return
  const { keepLoadId } = duplicateWarning.value
  duplicateWarning.value = null
  await sendExpense(buildPayload({ allowDuplicate: true }), keepLoadId)
}

// "No — it's already logged." The money is on file, so clearing the entry loses
// no evidence — but it is still a decision a person takes, never a default.
function discardDuplicate() {
  const w = duplicateWarning.value
  if (!w) return
  duplicateWarning.value = null
  resetAfterSubmit(w.keepLoadId)
  toast.show(
    w.existingId
      ? `Not logged — already on file as expense #${w.existingId}`
      : 'Not logged — treated as a duplicate',
    'warning',
  )
}

function clearAlreadyLogged() {
  const a = alreadyLogged.value
  if (!a) return
  alreadyLogged.value = null
  resetAfterSubmit(a.keepLoadId)
}

// The expense saved, but not into the month its date implies. Every month
// through 2026-07 is locked, so this is the common case, not an edge one.
//
// ⚠️ The double test is EXACTLY the one both admin surfaces use, and the second
// half is the load-bearing one: when `period_locks` cannot be read the server
// still moves the posting month but leaves `periodClosed` false. The receipt
// really did move — but we must not tell a driver a month is closed on the
// strength of a table we failed to read.
//
// ⚠️ Depends on the injected `submitHandler` RETURNING what the store returned,
// and it does: `DriverView.handleExpenseSubmit` returns the store's response, and
// LoadDetail forwards that same handler down as a prop — so this note is LIVE on
// both driver surfaces. It reads as dead code otherwise, which is how a working
// path gets deleted. Any new caller that injects its own handler must return the
// response too; the guard above fails closed on `undefined`, so a handler that
// swallows it goes silent rather than wrong.
function notePostedPeriod(res) {
  if (!(res?.periodClosed && res?.postedPeriod)) return
  const posted = monthLabel(res.postedPeriod)
  if (!posted) return
  const natural = monthLabel(res.naturalPeriod)
  postedNote.value = {
    heading: `Saved — booked to ${posted}`,
    body: natural
      ? `${natural} is already closed, so this receipt was filed in ${posted}. It keeps its own date — nothing is lost, and there is nothing to redo.`
      : `Its own month is already closed, so this receipt was filed in ${posted}. It keeps its own date — nothing is lost, and there is nothing to redo.`,
  }
}

// An edit to any field the duplicate check keys on (driver + day + amount, with
// the merchant and gallons deciding the verdict) makes the pending question
// obsolete — the server would now be comparing different values. Drop it and let
// the ordinary Submit ask again, rather than letting "log it anyway" carry an
// override the driver agreed to for a different entry.
watch(
  () => [form.amount, form.date, form.type, form.vendor].join('\u0000'),
  () => {
    if (duplicateWarning.value) duplicateWarning.value = null
  },
)

function resetAfterSubmit(keepLoadId) {
  form.amount = ''
  // Back to today, recomputed. Left alone, an OCR'd receipt date rode onto the
  // NEXT expense with no cue — a 2025-03-14 receipt followed by today's fuel
  // stop filed both in March 2025 — and a form left open across midnight kept
  // yesterday. Recomputing here fixes both, and `dateTouched` has to go with it
  // or the field would never accept a fresh default again.
  defaultedDate.value = houstonToday()
  form.date = defaultedDate.value
  dateTouched.value = false
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

/* Drag highlight on the Receipt Photo row. Inset ring + tint only, so the cell
   never changes size under the pointer mid-drag. Invisible on a phone by
   construction — dragActive can only be set by real drag events, which touch
   does not produce. */
.receipt-drop-over {
  background: var(--accent-dim, rgba(56, 189, 248, 0.1));
  box-shadow: inset 0 0 0 1.5px var(--accent, #38bdf8);
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
/* Saved, just not where the date implies. Blue, not red: nothing went wrong. */
.form-alert-info {
  background: #eff6ff;
  border-color: #bfdbfe;
  color: #1e3a8a;
}
/* Sits outside the inset cell group, level with the submit button — the same
   placement .form-alert-error already hard-codes. */
.form-alert-outer {
  margin: 0.75rem 0.75rem 0;
}
.form-alert-title {
  font-weight: 700;
  margin-bottom: 0.2rem;
}
/* Secondary line under the main message — the reassurance, not the fact. */
.form-alert-note {
  margin-top: 0.4rem;
  opacity: 0.85;
}
/* Stacked full-width buttons: a phone in a moving cab, gloves on. Vant's own
   small button already clears 44px of height with block+round. */
.form-alert-actions {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  margin-top: 0.7rem;
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
