<template>
  <div class="card expense-form-card">
    <div class="form-title">Log Expense</div>

    <div class="form-row">
      <div class="form-group">
        <label class="form-label">Type</label>
        <select v-model="form.type" class="form-select">
          <option value="Fuel">Fuel</option>
          <option value="Repair">Repair</option>
          <option value="Toll">Toll</option>
          <option value="Food">Food</option>
          <option value="Other">Other</option>
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">Amount ($)</label>
        <input
          v-model="form.amount"
          class="form-input"
          type="number"
          step="0.01"
          min="0"
          placeholder="0.00"
        />
      </div>
    </div>

    <div class="form-row">
      <div class="form-group">
        <label class="form-label">Date</label>
        <input v-model="form.date" class="form-input" type="date" />
      </div>
      <div class="form-group">
        <label class="form-label">Load</label>
        <select v-model="form.loadId" class="form-select">
          <option value="">General</option>
          <option
            v-for="id in loadIdOptions"
            :key="id"
            :value="id"
          >{{ id }}</option>
        </select>
      </div>
    </div>

    <div v-if="form.type === 'Fuel'" class="form-row">
      <div class="form-group">
        <label class="form-label">Gallons</label>
        <input
          v-model="form.gallons"
          class="form-input"
          type="number"
          step="0.1"
          min="0"
          placeholder="0.0"
        />
      </div>
      <div class="form-group">
        <label class="form-label">Odometer</label>
        <input
          v-model="form.odometer"
          class="form-input"
          type="number"
          step="1"
          min="0"
          placeholder="Miles"
        />
      </div>
    </div>

    <div class="form-group">
      <label class="form-label">Description</label>
      <textarea
        v-model="form.description"
        class="form-textarea"
        placeholder="Brief description..."
        maxlength="300"
      ></textarea>
    </div>

    <div class="form-group">
      <label class="form-label">Receipt Photo</label>
      <label class="photo-btn" for="expPhotoInput">&#128247; Capture / Upload Photo</label>
      <input
        id="expPhotoInput"
        ref="photoInput"
        type="file"
        accept="image/*"
        capture="camera"
        style="display: none"
        @change="handlePhoto"
      />
      <div v-if="photoPreview" class="photo-preview">
        <img :src="photoPreview" alt="Preview" />
      </div>
    </div>

    <button
      class="action-btn primary"
      :disabled="submitting"
      @click="handleSubmit"
    >Submit Expense</button>
  </div>
</template>

<script setup>
import { ref, reactive, computed } from 'vue'
import { useToast } from '../../composables/useToast'

const props = defineProps({
  loads: { type: Array, default: () => [] },
  driverName: { type: String, required: true },
  headers: { type: Array, default: () => [] },
})

const emit = defineEmits(['submit'])

const toast = useToast()
const photoInput = ref(null)
const photoPreview = ref('')
const photoBase64 = ref('')
const submitting = ref(false)

const form = reactive({
  type: 'Fuel',
  amount: '',
  date: new Date().toISOString().split('T')[0],
  loadId: '',
  description: '',
  gallons: '',
  odometer: '',
})

function findCol(headers, regex) {
  return (headers || []).find((h) => regex.test(h)) || null
}

const loadIdOptions = computed(() => {
  const loadIdCol = findCol(props.headers, /load.?id|job.?id/i)
  if (!loadIdCol) return []
  return props.loads
    .map((l) => l[loadIdCol])
    .filter(Boolean)
})

function handlePhoto(event) {
  const file = event.target.files[0]
  if (!file) return

  const reader = new FileReader()
  reader.onload = (e) => {
    const img = new Image()
    img.onload = () => {
      const canvas = document.createElement('canvas')
      const MAX = 200
      let w = img.width
      let h = img.height
      if (w > h) {
        h = Math.round((h * MAX) / w)
        w = MAX
      } else {
        w = Math.round((w * MAX) / h)
        h = MAX
      }
      canvas.width = w
      canvas.height = h
      canvas.getContext('2d').drawImage(img, 0, 0, w, h)
      photoBase64.value = canvas.toDataURL('image/jpeg', 0.6)
      photoPreview.value = photoBase64.value
    }
    img.src = e.target.result
  }
  reader.readAsDataURL(file)
}

async function handleSubmit() {
  const amount = parseFloat(form.amount)
  if (!amount || amount <= 0) {
    toast.show('Enter a valid amount', 'error')
    return
  }
  if (!form.date) {
    toast.show('Select a date', 'error')
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

    // Reset form
    form.amount = ''
    form.description = ''
    form.loadId = ''
    form.gallons = ''
    form.odometer = ''
    photoBase64.value = ''
    photoPreview.value = ''
    if (photoInput.value) photoInput.value.value = ''
  } finally {
    submitting.value = false
  }
}
</script>

<style scoped>
.form-title {
  font-weight: 600;
  font-size: 0.9rem;
  margin-bottom: 0.85rem;
}

.form-group {
  margin-bottom: 0.85rem;
}

.photo-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  width: 100%;
  padding: 0.75rem;
  border: 2px dashed var(--border);
  border-radius: 8px;
  background: var(--bg);
  color: var(--text-dim);
  font-family: inherit;
  font-size: 0.85rem;
  cursor: pointer;
  transition: all 0.15s;
}

.photo-btn:hover {
  border-color: var(--accent);
  color: var(--accent);
}

.photo-preview {
  margin-top: 0.5rem;
}

.photo-preview img {
  max-width: 120px;
  max-height: 120px;
  border-radius: 8px;
  border: 1px solid var(--border);
}

.action-btn {
  width: 100%;
  padding: 1rem;
  border: none;
  border-radius: var(--radius);
  font-family: inherit;
  font-size: 1rem;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s;
  min-height: 56px;
}

.action-btn.primary {
  background: var(--accent);
  color: #fff;
}

.action-btn.primary:hover {
  opacity: 0.9;
}

.action-btn.primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
