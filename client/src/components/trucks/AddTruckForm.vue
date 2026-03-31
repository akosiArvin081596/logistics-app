<template>
  <div class="card">
    <div class="admin-section-title">
      <div class="section-dot" style="background: var(--accent);"></div>
      New Truck
    </div>

    <div class="form-row">
      <div class="form-group">
        <label class="form-label">Unit Number</label>
        <input v-model="form.unitNumber" class="form-input" type="text" placeholder="e.g. TRK-1001" />
      </div>
      <div class="form-group">
        <label class="form-label">Status</label>
        <select v-model="form.status" class="form-select">
          <option value="Active">Active</option>
          <option value="Inactive">Inactive</option>
          <option value="Maintenance">Maintenance</option>
        </select>
      </div>
    </div>

    <div class="form-row">
      <div class="form-group">
        <label class="form-label">Make</label>
        <select v-model="form.make" class="form-select">
          <option value="">-- Select make --</option>
          <option v-for="m in truckMakes" :key="m" :value="m">{{ m }}</option>
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">Model</label>
        <select v-model="form.model" class="form-select" :disabled="!form.make">
          <option value="">{{ form.make ? '-- Select model --' : '-- Select make first --' }}</option>
          <option v-for="m in modelOptions" :key="m" :value="m">{{ m }}</option>
        </select>
      </div>
    </div>

    <div class="form-row">
      <div class="form-group">
        <label class="form-label">Year</label>
        <input v-model="form.year" class="form-input" type="number" placeholder="e.g. 2022" />
      </div>
      <div class="form-group">
        <label class="form-label">VIN</label>
        <input v-model="form.vin" class="form-input" type="text" placeholder="Vehicle Identification Number" />
      </div>
    </div>

    <div class="form-row">
      <div class="form-group">
        <label class="form-label">License Plate</label>
        <input v-model="form.licensePlate" class="form-input" type="text" placeholder="e.g. ABC-1234" />
      </div>
      <div class="form-group">
        <label class="form-label">Assigned Driver</label>
        <select v-model="form.assignedDriver" class="form-select">
          <option value="">-- No driver --</option>
          <option v-for="name in driverNames" :key="name" :value="name">{{ name }}</option>
        </select>
      </div>
    </div>

    <div class="form-group">
      <label class="form-label">Notes (optional)</label>
      <textarea v-model="form.notes" class="form-input form-textarea" rows="2" placeholder="Any additional notes..."></textarea>
    </div>

    <button class="btn btn-primary btn-add" @click="handleSubmit">Add Truck</button>
    <div class="error-msg">{{ errorMsg }}</div>
  </div>
</template>

<script setup>
import { reactive, ref, computed, watch } from 'vue'

const truckMakes = [
  'Freightliner', 'Kenworth', 'Peterbilt', 'Volvo', 'International',
  'Mack', 'Western Star', 'Hino', 'Isuzu', 'Ford', 'Chevrolet',
  'RAM', 'GMC', 'Tesla', 'Nikola', 'Other',
]

const truckModels = {
  Freightliner: ['Cascadia', 'Columbia', 'Coronado', 'M2 106', 'M2 112', '114SD', '122SD'],
  Kenworth: ['T680', 'T880', 'W900', 'W990', 'T270', 'T370', 'T440', 'T470'],
  Peterbilt: ['579', '389', '567', '520', '337', '348', '365', '367'],
  Volvo: ['VNL 760', 'VNL 860', 'VNL 300', 'VNR 300', 'VNR 400', 'VNR 600', 'VHD 300', 'VHD 400'],
  International: ['LT', 'RH', 'HV', 'HX', 'MV', 'CV'],
  Mack: ['Anthem', 'Pinnacle', 'Granite', 'LR', 'MD', 'TerraPro'],
  'Western Star': ['4900', '5700XE', '4700', '49X', '47X'],
  Hino: ['L6', 'L7', 'XL7', 'XL8', '268', '338'],
  Isuzu: ['NRR', 'NQR', 'NPR', 'NPR-HD', 'FTR', 'FVR'],
  Ford: ['F-650', 'F-750', 'F-59'],
  Chevrolet: ['Silverado 4500HD', 'Silverado 5500HD', 'Silverado 6500HD'],
  RAM: ['3500', '4500', '5500'],
  GMC: ['Sierra 3500HD', 'Sierra 4500HD', 'Sierra 5500HD'],
  Tesla: ['Semi'],
  Nikola: ['Tre BEV', 'Tre FCEV', 'Two'],
}

defineProps({
  driverNames: { type: Array, default: () => [] },
})

const emit = defineEmits(['submit'])

const modelOptions = computed(() => truckModels[form.make] || [])

watch(() => form.make, () => { form.model = '' })

const form = reactive({
  unitNumber: '',
  make: '',
  model: '',
  year: '',
  vin: '',
  licensePlate: '',
  status: 'Active',
  assignedDriver: '',
  notes: '',
})

const errorMsg = ref('')

function handleSubmit() {
  errorMsg.value = ''
  if (!form.unitNumber.trim()) {
    errorMsg.value = 'Unit number is required.'
    return
  }

  emit('submit', {
    unitNumber: form.unitNumber.trim(),
    make: form.make.trim(),
    model: form.model.trim(),
    year: form.year || 0,
    vin: form.vin.trim(),
    licensePlate: form.licensePlate.trim(),
    status: form.status,
    assignedDriver: form.assignedDriver,
    notes: form.notes.trim(),
  })

  form.unitNumber = ''
  form.make = ''
  form.model = ''
  form.year = ''
  form.vin = ''
  form.licensePlate = ''
  form.status = 'Active'
  form.assignedDriver = ''
  form.notes = ''
}
</script>

<style scoped>
.card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 1.25rem;
  margin-bottom: 1.25rem;
}
.admin-section-title {
  display: flex; align-items: center; gap: 0.5rem;
  font-weight: 700; font-size: 0.88rem; margin-bottom: 1rem;
}
.section-dot { width: 8px; height: 8px; border-radius: 50%; }
.form-row { display: flex; gap: 1rem; margin-bottom: 0.75rem; }
.form-row .form-group { flex: 1; }
.form-group { margin-bottom: 0.75rem; }
.form-textarea { resize: vertical; }
.btn-add { width: auto; padding: 0.5rem 1.5rem; }
.error-msg { color: var(--danger); font-size: 0.78rem; margin-top: 0.5rem; min-height: 1.1em; }
</style>
