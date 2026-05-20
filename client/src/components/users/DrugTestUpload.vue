<template>
  <div v-if="show" class="drug-test-overlay" @click.self="$emit('close')">
    <div class="drug-test-modal">
      <div class="modal-header">
        <h3>Upload Drug Test — {{ driverName }}</h3>
        <button class="close-btn" @click="$emit('close')">&times;</button>
      </div>
      <div class="modal-body">
        <div class="form-group">
          <label>Result</label>
          <select v-model="result" class="form-select">
            <option value="">Select result...</option>
            <option value="pass">Pass</option>
            <option value="fail">Fail</option>
          </select>
        </div>
        <div class="form-group">
          <label>Upload Document (PDF)</label>
          <input type="file" accept=".pdf,.jpg,.jpeg,.png" @change="handleFile" class="form-input" />
        </div>
        <button
          class="submit-btn"
          :disabled="!result || uploading"
          @click="handleSubmit"
        >
          {{ uploading ? 'Uploading...' : 'Upload Result' }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue'
import { useApi } from '../../composables/useApi'
import { useToast } from '../../composables/useToast'

const props = defineProps({
  show: { type: Boolean, default: false },
  userId: { type: Number, default: 0 },
  driverName: { type: String, default: '' },
})
const emit = defineEmits(['close', 'uploaded'])

const api = useApi()
const { show: toast } = useToast()
const result = ref('')
const fileData = ref('')
const fileName = ref('')
const uploading = ref(false)

function handleFile(e) {
  const file = e.target.files[0]
  if (!file) return
  fileName.value = file.name
  const reader = new FileReader()
  reader.onload = () => {
    fileData.value = reader.result.split(',')[1] // base64 without prefix
  }
  reader.readAsDataURL(file)
}

async function handleSubmit() {
  if (!result.value || uploading.value) return
  uploading.value = true
  try {
    await api.post(`/api/onboarding/${props.userId}/drug-test`, {
      result: result.value,
      fileData: fileData.value || undefined,
      fileName: fileName.value || undefined,
    })
    toast(`Drug test uploaded: ${result.value}`, 'success')
    emit('uploaded')
    emit('close')
  } catch (err) {
    toast(err.message || 'Upload failed', 'error')
  } finally {
    uploading.value = false
  }
}
</script>

<style scoped>
.drug-test-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 999;
}
.drug-test-modal {
  background: white;
  border-radius: 14px;
  width: 400px;
  max-width: 90vw;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.15);
}
.modal-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 1rem 1.25rem;
  border-bottom: 1px solid #e8edf2;
}
.modal-header h3 {
  font-size: 1rem;
  font-weight: 700;
  margin: 0;
}
.close-btn {
  background: none;
  border: none;
  font-size: 1.5rem;
  cursor: pointer;
  color: #6b7280;
}
.modal-body {
  padding: 1.25rem;
  display: flex;
  flex-direction: column;
  gap: 1rem;
}
.form-group label {
  display: block;
  font-size: 0.82rem;
  font-weight: 600;
  color: #374151;
  margin-bottom: 0.3rem;
}
.form-select, .form-input {
  width: 100%;
  padding: 0.5rem 0.75rem;
  border: 1px solid #e2e4ea;
  border-radius: 8px;
  font-size: 0.88rem;
}
.submit-btn {
  width: 100%;
  padding: 0.65rem;
  background: #2563eb;
  color: white;
  border: none;
  border-radius: 8px;
  font-weight: 700;
  font-size: 0.88rem;
  cursor: pointer;
}
.submit-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
