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

function handlePhoto(file) {
  const reader = new FileReader()
  reader.onload = (e) => {
    const img = new Image()
    img.onload = () => {
      const canvas = document.createElement('canvas')
      const MAX = 200
      let w = img.width
      let h = img.height
      if (w > h) { h = Math.round((h * MAX) / w); w = MAX }
      else { w = Math.round((w * MAX) / h); h = MAX }
      canvas.width = w
      canvas.height = h
      canvas.getContext('2d').drawImage(img, 0, 0, w, h)
      photoBase64.value = canvas.toDataURL('image/jpeg', 0.6)
    }
    img.src = e.target.result
  }
  reader.readAsDataURL(file.file)
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
    form.loadId = ''
    form.gallons = ''
    form.odometer = ''
    photoBase64.value = ''
    fileList.value = []
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
</style>
