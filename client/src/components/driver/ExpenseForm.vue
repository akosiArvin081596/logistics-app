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
        v-model="form.description"
        type="textarea"
        label="Description"
        placeholder="Brief description..."
        :maxlength="300"
        show-word-limit
        rows="2"
        autosize
      />

      <van-field label="Receipt Photo">
        <template #input>
          <van-uploader
            v-model="fileList"
            :max-count="1"
            :after-read="handlePhoto"
            accept="image/*"
            capture="camera"
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

const props = defineProps({
  loads: { type: Array, default: () => [] },
  driverName: { type: String, required: true },
  headers: { type: Array, default: () => [] },
})

const emit = defineEmits(['submit'])

const toast = useToast()
const submitting = ref(false)
const fileList = ref([])
const photoBase64 = ref('')
const showTypePicker = ref(false)
const showLoadPicker = ref(false)

const form = reactive({
  type: 'Fuel',
  amount: '',
  date: new Date().toISOString().split('T')[0],
  loadId: '',
  description: '',
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

function enhanceCanvas(ctx, w, h) {
  // Grayscale + linear contrast stretch. Keeps receipt paper bright white and
  // text crisp black; the cheap 2D canvas pass is fast even on low-end phones.
  const img = ctx.getImageData(0, 0, w, h)
  const d = img.data
  for (let i = 0; i < d.length; i += 4) {
    const gray = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]
    // Pull midtones toward 76 (our pivot) and stretch by 1.35.
    const boosted = Math.max(0, Math.min(255, (gray - 76) * 1.35 + 76))
    d[i] = d[i + 1] = d[i + 2] = boosted
  }
  ctx.putImageData(img, 0, 0)
}

function handlePhoto(file) {
  const reader = new FileReader()
  reader.onload = (e) => {
    const img = new Image()
    img.onload = async () => {
      const canvas = document.createElement('canvas')
      const MAX = 1600
      let w = img.width
      let h = img.height
      if (w > MAX || h > MAX) {
        if (w > h) { h = Math.round((h * MAX) / w); w = MAX }
        else { w = Math.round((w * MAX) / h); h = MAX }
      }
      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext('2d')
      ctx.drawImage(img, 0, 0, w, h)
      enhanceCanvas(ctx, w, h)
      photoBase64.value = canvas.toDataURL('image/jpeg', 0.9)
      await runReceiptOcr()
    }
    img.src = e.target.result
  }
  reader.readAsDataURL(file.file)
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
    description: form.description,
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
    if (data.vendor && !form.description) form.description = data.vendor
    if (data.gallons != null) form.gallons = String(data.gallons)
    if (data.odometer != null) form.odometer = String(data.odometer)
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
  form.description = preOcrSnapshot.value.description
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
      description: form.description,
      date: form.date,
      photoData: photoBase64.value,
      gallons: form.gallons || 0,
      odometer: form.odometer || 0,
    })

    form.amount = ''
    form.description = ''
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
