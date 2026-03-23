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
            <div v-for="h in headers" :key="h" class="form-field">
              <label>{{ h }}</label>
              <select
                v-if="isDriverField(h) && driverList.length"
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
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" @click="$emit('close')">Cancel</button>
          <button class="btn btn-primary" @click="handleSubmit">+ Add Row</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup>
import { reactive, watch } from 'vue'

const props = defineProps({
  headers: { type: Array, required: true },
  driverList: { type: Array, default: () => [] },
  open: { type: Boolean, default: false },
})

const emit = defineEmits(['submit', 'close'])

const formValues = reactive({})

function isDriverField(headerName) {
  return /^driver$/i.test(headerName.trim())
}

function handleSubmit() {
  const values = props.headers.map((h) => formValues[h] || '')
  if (values.every((v) => !v.trim())) return
  emit('submit', values)
  // Clear form after submit
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
      // Focus first input after render
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
</style>
