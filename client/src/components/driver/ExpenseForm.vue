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

    <div class="form-submit">
      <van-button round block type="primary" native-type="submit" :loading="submitting">
        Submit Expense
      </van-button>
    </div>
  </van-form>
</template>

<script setup>
import { ref, reactive, computed } from 'vue'
import { Form as VanForm, Field as VanField, CellGroup as VanCellGroup, Button as VanButton, Uploader as VanUploader, Picker as VanPicker, Popup as VanPopup } from 'vant'
import { useToast } from '../../composables/useToast'
import { useDocumentScan } from '../../composables/useDocumentScan'
import { compressImage } from '../../lib/imageUtils'

const props = defineProps({
  loads: { type: Array, default: () => [] },
  driverName: { type: String, required: true },
  headers: { type: Array, default: () => [] },
})

const emit = defineEmits(['submit'])

const toast = useToast()
const { scanDocument } = useDocumentScan()
const submitting = ref(false)
const fileList = ref([])
const photoBase64 = ref('')
const showTypePicker = ref(false)
const showLoadPicker = ref(false)

const form = reactive({
  type: 'Fuel',
  amount: '',
  date: new Date().toLocaleDateString('en-CA'),
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

async function handlePhoto(file) {
  const blob = file && file.file
  if (!blob) return
  // Decode + downscale to a JPEG data URL via the shared one-pass helper
  // (see imageUtils for the low-RAM OOM fix). Keep the receipt's 1024 max-edge.
  photoBase64.value = await compressImage(blob, 1024)
  if (!photoBase64.value) {
    toast.show("Couldn't process the photo — please retake", 'error')
    return
  }
  // Enhance the receipt via ScanKit (crop + flatten lighting) before OCR — a
  // cleaner image improves Gemini's read and is what we store as the receipt.
  // Cover the round-trip with the existing "Reading receipt…" spinner.
  ocrLoading.value = true
  await enhanceReceiptPhoto()
  await runReceiptOcr()
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
  ocrApplied.value = false
}

function handleSubmit() {
  if (!form.loadId) {
    toast.show('Select a load for this expense', 'error')
    return
  }
  const amount = parseFloat(form.amount)
  if (!amount || amount <= 0) {
    toast.show('Enter a valid amount', 'error')
    return
  }

  submitting.value = true
  try {
    emit('submit', {
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
    })

    form.amount = ''
    form.vendor = ''
    form.description = ''
    form.city = ''
    form.state = ''
    form.gallons = ''
    form.odometer = ''
    photoBase64.value = ''
    fileList.value = []
    ocrApplied.value = false
    ocrConfidence.value = ''
    preOcrSnapshot.value = null
    // Keep loadId if only one load (inside load detail)
    if (props.loads.length > 1) form.loadId = ''
  } finally {
    submitting.value = false
  }
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
</style>
