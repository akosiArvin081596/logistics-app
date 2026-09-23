<template>
  <!-- @failed: Vant refused a blank amount / date / load. Its message is drawn
       under the field, which on a phone is often off-screen above the Submit
       button that was just tapped — so the button looked dead. onValidateFailed
       takes the driver to it. Every validated field carries a `name`, because
       Vant reports (and can only locate) a failed field by name. -->
  <van-form class="expense-form" @submit="handleSubmit" @failed="onValidateFailed">
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
        ref="amountField"
        v-model="form.amount"
        name="amount"
        type="number"
        label="Amount ($)"
        placeholder="0.00"
        :rules="[{ required: true, message: 'Enter amount' }]"
      />

      <van-field
        ref="dateField"
        v-model="form.date"
        name="date"
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
        ref="loadField"
        v-model="form.loadId"
        name="loadId"
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

      <!-- Receipt Photo — TWO ways in: take one now, or choose one already on
           the phone. A receipt is as likely to be in the driver's gallery (shot
           at the pump, already sent to dispatch) as in their hand.

           ⚠️ This was ONE Vant uploader with capture="camera", and on a phone
           `capture` opens the camera and nothing else — no gallery, no files. A
           driver holding three fuel receipts in his gallery could not attach any
           of them: no scan, no read, no request ever left the phone.

           ⚠️ Two inputs, NOT one input without `capture`. Dropping the attribute
           does not "offer both": on Android 14+ Chrome an image-only input opens
           the system photo picker, which has no camera at all — that would trade
           the live shot every driver has used so far for the gallery. So the
           camera input keeps its `capture` exactly as before and the gallery
           input has none. DocumentUpload made the same call (Take Photo beside
           Upload File).

           A camera shot, a gallery pick and a desktop drop onto this row all go
           through attachPhoto(): the same HEIC → JPEG decode and 1024 px
           downscale before anything is sent, and the same thumbnail.

           The Vant uploader stays for what it does well — the thumbnail, the
           delete cross, tap-to-enlarge — and never opens a picker itself
           (:show-upload="false"). The pick buttons are real <button>s, so each
           way in is one keyboard stop with a readable name.

           The whole row is the drop target for desktop — drivers do open the
           portal on a laptop. v-bind adds only drag listeners (they fall through
           onto van-field's root cell), so the row's DOM and Vant's own cell
           hairline are unchanged; a wrapper <div> would have made this cell
           :last-child and silently dropped that border. -->
      <van-field
        label="Receipt Photo"
        :class="{ 'receipt-drop-over': dragActive }"
        v-bind="dropzoneProps"
      >
        <template #input>
          <div class="receipt-photo">
            <!-- :deletable — no × while the entry is being sent (up to 90 s).
                 Deleting mid-save made the retry photo-less, and without its
                 photo the byte-level duplicate check cannot catch that retry. -->
            <van-uploader
              v-if="fileList.length"
              v-model="fileList"
              :max-count="1"
              :show-upload="false"
              :deletable="!submitting"
              @delete="onPhotoDelete"
            />
            <div v-else class="receipt-pick" role="group" aria-label="Add a receipt photo">
              <button
                type="button"
                class="receipt-pick-btn receipt-pick-camera"
                :disabled="submitting"
                @click="cameraInput?.click()"
              >
                <span aria-hidden="true">&#128247;</span> Take photo
              </button>
              <button
                type="button"
                class="receipt-pick-btn"
                :disabled="submitting"
                @click="galleryInput?.click()"
              >
                <span aria-hidden="true">&#128444;&#65039;</span> Choose from gallery
              </button>
            </div>
            <input ref="cameraInput" type="file" accept="image/*" capture="camera" hidden @change="onPhotoPicked" />
            <input ref="galleryInput" type="file" accept="image/*" hidden @change="onPhotoPicked" />
          </div>
        </template>
      </van-field>

      <!-- Photo refused before it was ever uploaded. Deliberately a persistent
           block and not a toast: the driver has to DO something about it, and a
           toast is gone before someone at a truck stop has looked up. It sits
           directly under the Take photo button it is telling them to use. -->
      <div v-if="photoError" ref="photoErrorEl" class="form-alert form-alert-warn" role="alert">
        <div class="form-alert-title">That photo didn&rsquo;t come through</div>
        <div class="form-alert-body">
          Tap <strong>Take photo</strong> and photograph the receipt again. If it
          came from your gallery, a fresh photo with the camera works best.
        </div>
        <button type="button" class="form-alert-action" @click="dismissPhotoError">
          Log without a receipt
        </button>
      </div>

      <!-- From the moment a photo is picked until its read is done or skipped.
           Submit is held for exactly this long (see photoBusy). Skip appears
           once the network half starts: it keeps the photo and stops the read,
           so a slow scan or read can never hold the driver hostage. -->
      <div v-if="photoBusy" class="ocr-status ocr-status-loading" role="status" aria-live="polite">
        <span class="ocr-spinner" aria-hidden="true"></span>
        Reading receipt&hellip;
        <button
          v-if="photoStage === 'reading'"
          type="button"
          class="ocr-skip"
          aria-label="Skip reading the receipt and fill in the fields yourself"
          @click="skipReceiptRead"
        >
          Skip
        </button>
      </div>
      <div v-else-if="ocrApplied" class="ocr-status ocr-status-applied" :class="`ocr-conf-${ocrConfidence || 'medium'}`">
        <span class="ocr-dot"></span>
        Parsed from receipt &middot; please verify the amount
        <button type="button" class="ocr-undo" @click="undoAutofill">Undo autofill</button>
      </div>
    </van-cell-group>

    <!-- Submit failed. The server's own words, because it knows things this form
         cannot (a duplicate receipt, a closed month, a size cap). The heading is
         the part that matters at 2am: everything typed above is still there.

         ⚠️ Unless NO answer came back from the app (our timeout, a dropped
         connection, a gateway 502/504 — lib/saveOutcome.js, replyLost()).
         Then the row may well be saved and "Not submitted" would be a lie that
         sends the driver straight into a duplicate — so it says "Not confirmed",
         in amber, and points at the load's history, which the store re-reads in
         the background (stores/driver.js, submitExpense). -->
    <div
      v-if="submitError"
      class="form-alert"
      :class="submitUnconfirmed ? 'form-alert-warn form-alert-outer' : 'form-alert-error'"
      role="alert"
    >
      <div class="form-alert-title">
        <template v-if="submitUnconfirmed">Not confirmed &mdash; your entry is still here</template>
        <template v-else>Not submitted &mdash; your entry is still here</template>
      </div>
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

    <!-- Held while a photo is still being prepared or read. Submitting then
         filed the expense and cleared the form — and the read, landing late,
         refilled it with the old amount and a hidden photo, so a receipt that
         HAD saved looked unsent and was sent again. The label says why it is
         held; Skip on the reading line releases it. -->
    <div v-if="!decisionPending" class="form-submit">
      <van-button
        round
        block
        type="primary"
        native-type="submit"
        :loading="submitting"
        :disabled="photoBusy"
      >
        {{ photoBusy ? 'Reading receipt…' : submitError ? 'Try Again' : 'Submit Expense' }}
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
import { RECEIPT_MAX_EDGE, RECEIPT_SCAN_WIDTH, createPhotoJobs } from '../../lib/receiptPhoto'
import { replyLost } from '../../lib/saveOutcome'
// "2026-06" -> "June 2026". Shared, not local: the copy that used to live here
// was one of several, and two of them under one name in client/src/lib/ had
// OPPOSITE failure behaviour. This one returns '' when it cannot read the key,
// which is what notePostedPeriod()'s `if (!posted) return` depends on.
import { monthLabel } from '../../lib/monthLabel'

const props = defineProps({
  loads: { type: Array, default: () => [] },
  driverName: { type: String, required: true },
  headers: { type: Array, default: () => [] },
  // The load this form belongs to when it is opened from that load's own page
  // (LoadDetail passes its id). Preselected, and restored after every reset.
  // Without it the Load field started blank on a page with exactly one load to
  // pick, and its "Select a load" error sat off-screen, so Submit looked dead.
  presetLoadId: { type: String, default: '' },
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
// The last submit got NO reply (timeout, dropped connection), so it may have
// saved. Changes the heading from "Not submitted" to "Not confirmed".
const submitUnconfirmed = ref(false)

// The receipt photo in flight: '' (idle), 'preparing' (decoding on the phone),
// 'reading' (ScanKit + Gemini, over the network). Anything but '' holds Submit.
const photoStage = ref('')
const photoBusy = computed(() => photoStage.value !== '')
// One job per picked photo; a late answer for a photo that is gone is dropped.
// See createPhotoJobs() in lib/receiptPhoto.js.
const photoJobs = createPhotoJobs()
const cameraInput = ref(null)
const galleryInput = ref(null)
const photoErrorEl = ref(null)
const amountField = ref(null)
const dateField = ref(null)
const loadField = ref(null)

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
// A refusal is a toast, not the photoError block: that block's copy is "tap Take
// photo and photograph it again", which is the wrong instruction for "you
// dropped a PDF", and nothing was attached so there is no state to unwind.
const { dropzoneProps, dragActive, error: dropError, clearMessages: clearDropError } = useFileDrop({
  accept: 'image/*,.heic,.heif',
  maxSizeMb: 20,
  // Attached exactly like a pick — thumbnail, delete cross and all. A drop used
  // to go straight to handlePhoto and skip the uploader, so the photo rode along
  // on the submit with no thumbnail: attached, but invisible and undeletable.
  onFiles: (files) => attachPhoto(files[0]),
})

// ⚠️ Watched on the `error` REF, not through onReject: a dropped FOLDER is
// caught before validation runs and never reaches onReject, so rejections alone
// would leave the commonest mis-drop silent.
watch(dropError, (msg) => {
  if (!msg) return
  toast.show(msg, 'error')
  clearDropError()
})

// The row binds dropzoneProps as they are. It used to wrap onDrop so that a drop
// landing ON Vant's visible "+" tile input was left to the input — Vant's own
// uploader then read it. Neither exists any more: the uploader never shows its
// upload tile (:show-upload="false") and both pick inputs are `hidden`, so there
// is no visible file input on this row for a drop to land on, and every drop
// goes through attachPhoto().

const form = reactive({
  type: 'Fuel',
  amount: '',
  date: houstonToday(),
  // The load this form was opened from, preselected. See the watcher below.
  loadId: props.presetLoadId || '',
  vendor: '',
  description: '',
  city: '',
  state: '',
  gallons: '',
  odometer: '',
})

// The page can switch to another load under a still-mounted form: the "new
// load" banner does exactly that, and LoadDetail has no :key. The Load field
// follows the page ONLY while the entry is pristine. Mid-entry it stays put:
// following would file load A's fuel under load B with nothing on screen to
// say so, while left alone the field still names A for the driver to check. A
// load the driver picked themselves is never overridden either. `presetApplied`
// is the last value this watcher (or a reset) put in the field, which is how a
// preset is told apart from a pick.
//
// Not `immediate`: `form` already starts on the preset, and isPristineEntry()
// reads state declared further down this file.
let presetApplied = form.loadId
watch(
  () => props.presetLoadId,
  (id) => {
    if (!id || !isPristineEntry()) return
    if (form.loadId && form.loadId !== presetApplied) return
    form.loadId = presetApplied = id
  },
)

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
  // fileList/photoBusy: a photo still decoding has no photoBase64 yet, but it
  // is already the driver's entry.
  return (
    !form.amount && !form.vendor && !form.description && !form.city && !form.state &&
    !form.gallons && !form.odometer && !photoBase64.value && !ocrApplied.value && !photoError.value &&
    !fileList.value.length && !photoBusy.value
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
const ocrApplied = ref(false)
const ocrConfidence = ref('')
// Dynamic receipt details parsed by OCR ({label,value}[]). Carried straight
// through to create under the same trust model as amount/vendor — no editor UI.
const ocrDetails = ref([])

// How long the driver waits on the Gemini read before it is abandoned. The
// server's own budget is three 15 s attempts (lib/receipt-ocr.js), and the admin
// receipt forms use the same 50 s. This fetch used to have NO timeout — harmless
// while nothing waited on it, but it now holds Submit, so an unanswered read
// would hold Submit forever. (Skip releases it sooner.)
const OCR_TIMEOUT_MS = 50000

// ── Receipt photo ────────────────────────────────────────────────────────────
// A picked (or dropped) file becomes the uploader's single item, in the shape
// Vant's own after-read built — { file, status, message, objectUrl } — so the
// thumbnail, the delete cross and tap-to-enlarge behave as they always did.
// reactive() as Vant does it, because showDecodedPreview() repoints the
// thumbnail later and the uploader must see that.
function attachPhoto(file) {
  if (!file) return
  // Not while this entry is being sent: a successful save resets the form, and
  // a photo added mid-flight would be wiped with it, unsent. (The pick buttons
  // are disabled for the same window; this also covers a desktop drop.)
  if (submitting.value) {
    toast.show('Wait until this expense has finished sending', 'warning')
    return
  }
  const item = reactive({ file, status: '', message: '', objectUrl: URL.createObjectURL(file) })
  fileList.value = [item]
  handlePhoto(item)
}

// Both pick inputs land here. ⚠️ The input is cleared BEFORE handling, not after
// (DocumentUpload's handleFile learned this): re-picking the same file after a
// refusal otherwise fires no change event, so the driver's obvious recovery —
// pick it again — silently does nothing.
function onPhotoPicked(event) {
  const file = event.target.files && event.target.files[0]
  event.target.value = ''
  attachPhoto(file)
}

// An object URL pins the picked file in memory until it is revoked. Released
// the moment the item leaves the uploader — replaced, deleted, refused, reset —
// and on unmount. (Vant revokes only the URLs it created itself.)
function releasePhotoItem(item) {
  if (item && item.objectUrl) {
    URL.revokeObjectURL(item.objectUrl)
    item.objectUrl = ''
  }
}
watch(fileList, (next, prev) => {
  for (const item of prev || []) {
    if (!(next || []).includes(item)) releasePhotoItem(item)
  }
})

// Point the thumbnail at the decoded JPEG — the picture that will actually be
// sent — instead of the picked file. A gallery HEIC on Chrome/Android cannot be
// drawn from its own bytes, so its thumbnail was a broken image over a receipt
// that was perfectly fine: exactly the "did it attach?" doubt this form exists
// to remove. `content` feeds the thumbnail, `url` feeds tap-to-enlarge.
function showDecodedPreview(item, dataUrl) {
  releasePhotoItem(item)
  item.content = dataUrl
  item.url = dataUrl
  item.isImage = true
}

// decode → enhance → read, for ONE photo. Every await is followed by a check
// that this photo is still the one on the form (photoJobs, lib/receiptPhoto.js):
// a new photo, the delete cross, a successful submit's reset and unmounting all
// retire the job, and a retired job writes nothing — not the picture, not the
// fields, not a toast. That is what stops a late read refilling a form that has
// already been filed.
async function handlePhoto(item) {
  const blob = item && item.file
  if (!blob) return
  const job = photoJobs.start()
  photoStage.value = 'preparing'
  photoError.value = false
  submitError.value = ''
  submitUnconfirmed.value = false
  // A new receipt is a new question. In particular DUPLICATE_RECEIPT is keyed on
  // the bytes, so replacing the photo is one of the two ways out of it.
  duplicateWarning.value = null
  alreadyLogged.value = null
  // The previous photo stops being the attachment NOW, not when this one is
  // ready: nothing may be sent with a picture the thumbnail no longer shows.
  photoBase64.value = ''
  // ...and so does everything the previous photo's READ left behind. ocrDetails
  // is never on screen but rides on the submit, and the server classifies the
  // receipt from it (isDefReceipt): without this, photo B tapped through with
  // Skip was filed carrying photo A's details — a diesel fill flagged as DEF,
  // or the reverse — under a "Parsed from receipt" line and an Undo that no
  // longer matched anything. Fields A's read filled in stay: they are on
  // screen, and B's read or the driver replaces them.
  ocrApplied.value = false
  ocrConfidence.value = ''
  ocrDetails.value = []
  preOcrSnapshot.value = null
  // Decode + downscale to a JPEG data URL via the shared one-pass helper (see
  // imageUtils for the low-RAM OOM fix, and its HEIC → JPEG conversion — which
  // a gallery pick needs far more often than a camera shot does).
  // compressImage is written never to throw; the catch makes that guarantee
  // local, because a throw here would leave photoStage at 'preparing' and hold
  // Submit for good. A decode that throws is a photo we could not read.
  let decoded = ''
  try {
    decoded = await compressImage(blob, RECEIPT_MAX_EDGE)
  } catch {
    decoded = ''
  }
  if (!photoJobs.isCurrent(job)) return
  // Two failures, one outcome. '' is an unreadable file; a non-JPEG/PNG/WebP
  // data URL is compressImage's raw-bytes fallback, i.e. a file it could not
  // decode at all — an SVG, a mislabelled document, a HEIC even heic2any
  // refused. The server verifies the real magic bytes and 400s that, and the
  // path this replaces booked the expense while silently dropping the receipt.
  // Catch it here, while the driver still has the camera in their hand.
  if (!decoded || !isDecodedImage(decoded)) {
    rejectPhoto()
    return
  }
  photoBase64.value = decoded
  showDecodedPreview(item, decoded)
  if (!photoJobs.mayRead(job)) {
    photoStage.value = ''
    return
  }
  // Enhance the receipt via ScanKit (crop + flatten lighting) before OCR — a
  // cleaner image improves Gemini's read and is what we store as the receipt.
  photoStage.value = 'reading'
  await enhanceReceiptPhoto(job)
  await runReceiptOcr(job)
  if (photoJobs.isCurrent(job)) photoStage.value = ''
}

// Drop an unusable photo and say so. Emptying fileList matters as much as the
// message: max-count is 1, so a refused file left in the uploader would keep
// its thumbnail up and the two pick buttons hidden, and the driver could not
// retake without first finding the small delete cross.
function rejectPhoto() {
  photoJobs.cancel()
  photoStage.value = ''
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

// The delete cross on the thumbnail. What the driver sees is what gets sent:
// the picture leaves the payload with its thumbnail — before this, a deleted
// photo stayed in photoBase64 and quietly rode along on the next submit — and
// anything still in flight for it is dropped. Typed and read-in fields stay;
// "Undo autofill" still covers the latter.
function onPhotoDelete() {
  photoJobs.cancel()
  photoStage.value = ''
  photoBase64.value = ''
}

// "Skip" on the reading line: stop waiting for ScanKit and Gemini. The photo
// stays attached exactly as it is at this moment — raw, or already enhanced —
// and nothing the read returns afterwards may touch the form. Offered only
// while 'reading': during 'preparing' there is no photo to keep yet, so
// releasing Submit then would file the expense without it.
function skipReceiptRead() {
  if (photoStage.value !== 'reading') return
  photoJobs.skipRead()
  photoStage.value = ''
  preOcrSnapshot.value = null
}

// Best-effort receipt enhancement. Any failure (scanning disabled, no credits,
// rate limited, network, Skip) keeps the raw compressed photo so OCR + submit
// still work — the driver is never blocked.
async function enhanceReceiptPhoto(job) {
  const raw = photoBase64.value
  if (!raw) return
  try {
    const res = await scanDocument(raw, {
      returnPdf: false,
      filter: 'flat',
      // No wider than the photo's own long edge — the server default of 1536
      // upscaled every receipt before it was uploaded. See RECEIPT_SCAN_WIDTH.
      outputWidth: RECEIPT_SCAN_WIDTH,
      signal: job.signal,
    })
    if (photoJobs.mayRead(job) && res && res.data) photoBase64.value = res.data
  } catch {
    // Keep the raw photo — enhancement is a nice-to-have, not required.
  }
}

async function runReceiptOcr(job) {
  if (!photoJobs.mayRead(job) || !photoBase64.value) return
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
  // Aborted by the job (new photo, delete, Skip, reset, unmount) or by our own
  // timeout, whichever comes first. Composed by hand: AbortSignal.any/timeout
  // are too new for the older iPhones drivers carry.
  const ctrl = new AbortController()
  const onJobAbort = () => ctrl.abort()
  job.signal.addEventListener('abort', onJobAbort)
  const timer = setTimeout(() => ctrl.abort(), OCR_TIMEOUT_MS)
  try {
    const res = await fetch('/api/expenses/ocr', {
      method: 'POST',
      // Bypasses useApi, so it carries the CSRF header itself — see useApi.js.
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      body: JSON.stringify({ photoData: photoBase64.value }),
      signal: ctrl.signal,
    })
    const data = res.ok ? await res.json() : null
    // Answered for a photo that is gone, or after Skip: drop it, silently. Its
    // values would land on a form that has moved on — which is the bug.
    if (!photoJobs.mayRead(job)) return
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
    // A retired job's abort lands here too — and must stay silent.
    if (!photoJobs.mayRead(job)) return
    toast.show('Couldn\'t read receipt — please fill in the fields', 'error')
    preOcrSnapshot.value = null
  } finally {
    clearTimeout(timer)
    job.signal.removeEventListener('abort', onJobAbort)
  }
}

onBeforeUnmount(() => {
  photoJobs.cancel()
  fileList.value.forEach(releasePhotoItem)
})

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
  // The button is disabled while a photo is being prepared or read; this covers
  // every other way into a submit (Enter in a field). Filing now would send the
  // entry without the picture on screen, or let a late read rewrite the form
  // that replaced it. Checked before anything below is cleared.
  if (photoBusy.value) {
    toast.show('Still reading the receipt — one moment', 'warning')
    return
  }
  submitError.value = ''
  submitUnconfirmed.value = false
  // Each of these describes the PREVIOUS attempt. Clearing them here (and only
  // here) is what keeps the posted-month note on screen after a successful
  // submit — resetAfterSubmit deliberately leaves it alone.
  duplicateWarning.value = null
  alreadyLogged.value = null
  postedNote.value = null

  // Each refusal below also TAKES the driver to the field: a toast alone left
  // them staring at a Submit button that "did nothing" (see onValidateFailed).
  if (!form.loadId) {
    toast.show('Select a load for this expense', 'error')
    revealField('loadId')
    return
  }
  const amount = parseFloat(form.amount)
  if (!amount || amount <= 0) {
    toast.show('Enter a valid amount', 'error')
    revealField('amount')
    return
  }
  // A photo was attached, refused, and not replaced. Submitting now books the
  // expense with no receipt — the same silent evidence loss the byte check
  // exists to stop — so make dropping it a decision rather than a default.
  if (photoError.value) {
    toast.show('Retake the photo, or tap "Log without a receipt"', 'error')
    photoErrorEl.value?.scrollIntoView?.({ block: 'center', behavior: 'smooth' })
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
  // No answer from the app (timeout, dropped connection, gateway 502/504): the
  // row may have SAVED. The same test drives the store's background re-read.
  submitUnconfirmed.value = replyLost(err)
  submitError.value = failureText(err)
}

// The question replaces the submit button the driver just tapped, and on a long
// form in a cab that can land off-screen. Bring it to them.
function revealDecision() {
  nextTick(() => {
    decisionEl.value?.scrollIntoView?.({ block: 'center', behavior: 'smooth' })
  })
}

// Vant refused the submit (a required field is blank) and drew its message under
// that field — often off-screen above the button that was tapped, so Submit
// looked dead. errors[] arrives in form order; take the driver to the first.
function onValidateFailed({ errors } = {}) {
  revealField(errors && errors[0] && errors[0].name)
}

// Scroll a validated field (by its `name`) to the middle of the screen and put
// focus in it, so a screen reader lands where the error was just drawn. Focus
// uses preventScroll: a second, instant jump would fight the smooth one.
const FIELD_REFS = { amount: amountField, date: dateField, loadId: loadField }
function revealField(name) {
  const el = FIELD_REFS[name]?.value?.$el
  if (!el) return
  el.scrollIntoView?.({ block: 'center', behavior: 'smooth' })
  el.querySelector?.('input, textarea')?.focus?.({ preventScroll: true })
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
  // Anything still decoding, scanning or reading belongs to the entry that was
  // just filed, and must never land on the empty form that replaces it — that
  // is what made a SAVED receipt look unsent. (Submit is held while a photo is
  // busy, so this is the backstop for the paths that clear without a submit.)
  photoJobs.cancel()
  photoStage.value = ''
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
  submitUnconfirmed.value = false
  ocrApplied.value = false
  ocrConfidence.value = ''
  ocrDetails.value = []
  preOcrSnapshot.value = null
  // A finished entry hands the form back to the page's own load — including
  // when the field was deliberately left on another load mid-entry (see the
  // presetLoadId watcher). With no page load, the old rule: keep the load when
  // there is only one to pick (inside load detail), otherwise clear it.
  if (props.presetLoadId) form.loadId = presetApplied = props.presetLoadId
  else if (!keepLoadId) form.loadId = ''
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
  // Not the transport's words ("Load failed", "Failed to fetch", "timed out …
  // try again"): each tells the driver it failed and to resend, and the resend
  // is what the duplicate guard then refuses. The honest answer is "unknown",
  // plus where to look — the store re-reads the history in the background.
  if (replyLost(err)) {
    return 'No answer came back from the server, so this may already be saved. Check this load’s Expense History below before you try again — if it did save, trying again will say so.'
  }
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

/* The two ways to add a receipt. Stacked full-width rather than side by side:
   "Choose from gallery" does not fit half of a phone's value column, and each
   target clears 44px for a gloved thumb. Dashed boxes, as DocumentUpload's
   Take Photo / Upload File pair — the camera one tinted as the usual path. */
.receipt-photo {
  width: 100%;
}
.receipt-pick {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  width: 100%;
}
.receipt-pick-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.4rem;
  width: 100%;
  min-height: 44px;
  padding: 0.5rem 0.75rem;
  border: 1.5px dashed var(--border, #cbd5e1);
  border-radius: var(--radius, 8px);
  background: transparent;
  color: var(--text-dim, #64748b);
  font-family: inherit;
  font-size: 0.85rem;
  font-weight: 600;
  cursor: pointer;
  transition: border-color 0.15s;
}
.receipt-pick-btn:hover {
  border-color: var(--accent, #38bdf8);
}
.receipt-pick-btn:focus-visible {
  outline: 2px solid var(--accent, #38bdf8);
  outline-offset: 2px;
}
.receipt-pick-btn:disabled {
  opacity: 0.55;
  cursor: progress;
}
.receipt-pick-camera {
  color: var(--accent, #38bdf8);
  border-color: var(--accent, #38bdf8);
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
/* Skip on the reading line. Same outline as Undo, but a full 44px target: it is
   the one control on this line a driver may need at a pump. */
.ocr-skip {
  margin-left: auto;
  min-height: 44px;
  padding: 0 0.9rem;
  background: transparent;
  border: 1px solid currentColor;
  border-radius: 8px;
  color: inherit;
  font-family: inherit;
  font-size: 0.78rem;
  font-weight: 600;
  cursor: pointer;
}
.ocr-skip:hover {
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
