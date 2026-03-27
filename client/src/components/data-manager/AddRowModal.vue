<template>
  <Teleport to="body">
    <div v-if="open" class="modal-overlay" @click.self="$emit('close')">
      <div class="modal" @keydown.escape="$emit('close')">
        <div class="modal-header">
          <h3>Add New Row</h3>
          <button class="modal-close" @click="$emit('close')">&times;</button>
        </div>
        <div class="modal-body">
          <div class="modal-form">
            <!-- Origin location picker -->
            <div v-if="hasOriginCoords" class="form-field location-field">
              <label>Origin Location</label>
              <div class="location-picker-row">
                <span v-if="formValues[originLatCol]" class="location-summary">
                  {{ formValues[originCityCol] || `${formValues[originLatCol]}, ${formValues[originLngCol]}` }}
                </span>
                <span v-else class="location-placeholder">No location selected</span>
                <button type="button" class="btn btn-secondary btn-sm" @click="openPicker('origin')">
                  Pick on Map
                </button>
              </div>
            </div>

            <!-- Destination location picker -->
            <div v-if="hasDestCoords" class="form-field location-field">
              <label>Destination Location</label>
              <div class="location-picker-row">
                <span v-if="formValues[destLatCol]" class="location-summary">
                  {{ formValues[destCityCol] || `${formValues[destLatCol]}, ${formValues[destLngCol]}` }}
                </span>
                <span v-else class="location-placeholder">No location selected</span>
                <button type="button" class="btn btn-secondary btn-sm" @click="openPicker('destination')">
                  Pick on Map
                </button>
              </div>
            </div>

            <!-- Regular form fields -->
            <template v-for="h in headers" :key="h">
              <div v-if="!hiddenCoordHeaders.has(h)" class="form-field">
                <label>{{ h }}</label>
                <select
                  v-if="isDriverField(h) && driverList.length && props.currentSheet !== 'Carrier Database'"
                  v-model="formValues[h]"
                >
                  <option value="">Select driver</option>
                  <option v-for="d in driverList" :key="d" :value="d">{{ d }}</option>
                </select>
                <input
                  v-else
                  v-model="formValues[h]"
                  :placeholder="`Enter ${h.toLowerCase()}`"
                />
              </div>
            </template>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" @click="$emit('close')">Cancel</button>
          <button class="btn btn-primary" @click="handleSubmit">+ Add Row</button>
        </div>
      </div>
    </div>
  </Teleport>

  <LocationPickerModal
    :open="pickerOpen"
    :label="pickerTarget === 'origin' ? 'Origin' : 'Destination'"
    :initial-lat="pickerInitialLat"
    :initial-lng="pickerInitialLng"
    @confirm="onLocationPicked"
    @close="pickerOpen = false"
  />
</template>

<script setup>
import { reactive, ref, computed, watch } from 'vue'
import LocationPickerModal from './LocationPickerModal.vue'

const props = defineProps({
  headers: { type: Array, required: true },
  driverList: { type: Array, default: () => [] },
  currentSheet: { type: String, default: '' },
  open: { type: Boolean, default: false },
})

const emit = defineEmits(['submit', 'close'])

const formValues = reactive({})
const pickerOpen = ref(false)
const pickerTarget = ref('origin')

// Column detection (same regex patterns as DriverRouteMap.vue / LoadCard.vue)
function findCol(regex) {
  return (props.headers || []).find((h) => regex.test(h)) || null
}

const originLatCol = computed(() => findCol(/origin.*lat|pickup.*lat|shipper.*lat/i))
const originLngCol = computed(() => findCol(/origin.*l(on|ng)|pickup.*l(on|ng)|shipper.*l(on|ng)/i))
const destLatCol = computed(() => findCol(/dest.*lat|drop.*lat|receiver.*lat|delivery.*lat/i))
const destLngCol = computed(() => findCol(/dest.*l(on|ng)|drop.*l(on|ng)|receiver.*l(on|ng)|delivery.*l(on|ng)/i))
const originCityCol = computed(() => findCol(/origin|pickup.*city|shipper.*city/i))
const destCityCol = computed(() => findCol(/dest|drop.*city|receiver.*city|delivery.*city|consignee.*city/i))

const hasOriginCoords = computed(() => !!originLatCol.value && !!originLngCol.value)
const hasDestCoords = computed(() => !!destLatCol.value && !!destLngCol.value)

const hiddenCoordHeaders = computed(() => {
  const set = new Set()
  if (hasOriginCoords.value) {
    set.add(originLatCol.value)
    set.add(originLngCol.value)
  }
  if (hasDestCoords.value) {
    set.add(destLatCol.value)
    set.add(destLngCol.value)
  }
  return set
})

const pickerInitialLat = computed(() => {
  const col = pickerTarget.value === 'origin' ? originLatCol.value : destLatCol.value
  return col ? parseFloat(formValues[col]) : NaN
})
const pickerInitialLng = computed(() => {
  const col = pickerTarget.value === 'origin' ? originLngCol.value : destLngCol.value
  return col ? parseFloat(formValues[col]) : NaN
})

function isDriverField(headerName) {
  return /^driver$/i.test(headerName.trim())
}

function openPicker(target) {
  pickerTarget.value = target
  pickerOpen.value = true
}

function onLocationPicked({ lat, lng, displayName }) {
  if (pickerTarget.value === 'origin') {
    if (originLatCol.value) formValues[originLatCol.value] = String(lat.toFixed(6))
    if (originLngCol.value) formValues[originLngCol.value] = String(lng.toFixed(6))
    if (originCityCol.value && displayName) formValues[originCityCol.value] = displayName
  } else {
    if (destLatCol.value) formValues[destLatCol.value] = String(lat.toFixed(6))
    if (destLngCol.value) formValues[destLngCol.value] = String(lng.toFixed(6))
    if (destCityCol.value && displayName) formValues[destCityCol.value] = displayName
  }
  pickerOpen.value = false
}

function handleSubmit() {
  const values = props.headers.map((h) => formValues[h] || '')
  if (values.every((v) => !v.trim())) return
  emit('submit', values)
  props.headers.forEach((h) => {
    formValues[h] = ''
  })
}

// Initialize / reset form values when headers change or modal opens
watch(
  () => props.headers,
  (hdrs) => {
    hdrs.forEach((h) => {
      if (!(h in formValues)) formValues[h] = ''
    })
  },
  { immediate: true }
)

watch(
  () => props.open,
  (isOpen) => {
    if (isOpen) {
      props.headers.forEach((h) => {
        formValues[h] = ''
      })
      setTimeout(() => {
        const first = document.querySelector('.modal-form input, .modal-form select')
        if (first) first.focus()
      }, 100)
    }
  }
)
</script>

<style scoped>
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.35);
  z-index: 200;
  display: flex;
  align-items: center;
  justify-content: center;
}
.modal {
  background: var(--surface);
  border-radius: 14px;
  width: 90%;
  max-width: 720px;
  max-height: 85vh;
  overflow-y: auto;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.15);
  animation: modalIn 0.2s ease-out;
}
@keyframes modalIn {
  from {
    transform: translateY(12px) scale(0.97);
    opacity: 0;
  }
  to {
    transform: translateY(0) scale(1);
    opacity: 1;
  }
}
.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 1.25rem 1.5rem;
  border-bottom: 1px solid var(--border);
}
.modal-header h3 {
  font-size: 1.05rem;
  font-weight: 700;
}
.modal-close {
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--text-dim);
  font-size: 1.2rem;
  cursor: pointer;
  transition: all 0.12s;
}
.modal-close:hover {
  background: var(--surface-hover);
  color: var(--text);
}
.modal-body {
  padding: 1.5rem;
}
.modal-form {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 1rem;
}
.modal-footer {
  display: flex;
  justify-content: flex-end;
  gap: 0.6rem;
  padding: 1rem 1.5rem;
  border-top: 1px solid var(--border);
}
.form-field {
  min-width: 0;
}
.form-field label {
  display: block;
  font-size: 0.75rem;
  color: #374151;
  margin-bottom: 0.3rem;
  font-weight: 600;
}
.form-field input {
  width: 100%;
  padding: 0.55rem 0.75rem;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 6px;
  color: var(--text);
  font-family: 'DM Sans', sans-serif;
  font-size: 0.88rem;
  outline: none;
  transition: border-color 0.2s;
}
.form-field input::placeholder {
  color: #9ca3b0;
}
.form-field input:focus {
  border-color: var(--accent);
}
.form-field select {
  width: 100%;
  padding: 0.55rem 0.75rem;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 6px;
  color: var(--text);
  font-family: 'DM Sans', sans-serif;
  font-size: 0.88rem;
  outline: none;
  transition: border-color 0.2s;
  cursor: pointer;
}
.form-field select:focus {
  border-color: var(--accent);
}

/* Location picker fields */
.location-field {
  grid-column: 1 / -1;
}
.location-picker-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.55rem 0.75rem;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 6px;
}
.location-summary {
  flex: 1;
  font-size: 0.82rem;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.location-placeholder {
  flex: 1;
  font-size: 0.82rem;
  color: var(--text-dim);
}
.btn-sm {
  padding: 0.35rem 0.75rem;
  font-size: 0.78rem;
  white-space: nowrap;
}
</style>
