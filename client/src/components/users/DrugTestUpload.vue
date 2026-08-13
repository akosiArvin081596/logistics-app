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
          <label>Upload Document</label>
          <!-- Extension-only accept, unchanged from the input it replaces: it is
               what the server names the file from, and .webp stays out because
               it was never in. On a drop the attribute is decorative, so this
               list is now enforced by the shared validator instead. -->
          <FileDropZone
            accept=".pdf,.jpg,.jpeg,.png"
            :max-size-mb="10"
            :disabled="uploading"
            :label="fileName || 'Drop the drug test result'"
            @files="handleFile"
          />
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
import FileDropZone from '../shared/FileDropZone.vue'
import { readFileAsDataURL } from '../../lib/imageUtils'

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

// Receives an already-validated File[] from BOTH paths — the zone's click-to-
// browse and a drop on it. One file at a time (`multiple` is off on the zone).
async function handleFile(files) {
  const file = files[0]
  if (!file) return
  const dataUrl = await readFileAsDataURL(file)
  // readFileAsDataURL resolves '' on an unreadable file rather than rejecting.
  // Naming the file without its bytes would let Upload run and file a drug test
  // result with no document attached, so neither is set unless both are good.
  if (!dataUrl) {
    fileName.value = ''
    fileData.value = ''
    toast(`Couldn't read "${file.name}". Try choosing it again.`, 'error')
    return
  }
  fileName.value = file.name
  fileData.value = String(dataUrl).split(',')[1] // base64 without prefix
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
