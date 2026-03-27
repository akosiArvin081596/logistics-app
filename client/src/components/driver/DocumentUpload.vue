<template>
  <div class="card doc-upload">
    <div class="doc-header">{{ headerText }}</div>
    <p class="doc-hint">{{ hintText }}</p>

    <!-- Document type selector -->
    <select
      v-if="showTypeSelector"
      v-model="selectedType"
      class="type-select"
    >
      <option v-for="t in docTypes" :key="t.value" :value="t.value">{{ t.label }}</option>
    </select>

    <label class="photo-btn">
      <input
        ref="fileInput"
        type="file"
        accept="image/*"
        capture="camera"
        hidden
        @change="handlePhoto"
      />
      <span v-if="!preview">&#128247; Capture / Upload Photo</span>
      <img v-else :src="preview" alt="Preview" class="doc-preview" />
    </label>

    <button
      class="btn btn-primary"
      :disabled="!photoData || uploading"
      @click="handleUpload"
    >
      {{ uploading ? 'Uploading...' : `Upload ${selectedType}` }}
    </button>
  </div>
</template>

<script setup>
import { ref, computed, watch } from 'vue'
import { useApi } from '../../composables/useApi'
import { useToast } from '../../composables/useToast'

const props = defineProps({
  loadId: { type: String, required: true },
  driverName: { type: String, required: true },
  rowIndex: { type: Number, required: true },
  docType: { type: String, default: null },
  showTypeSelector: { type: Boolean, default: true },
})

const emit = defineEmits(['uploaded'])

const api = useApi()
const toast = useToast()

const docTypes = [
  { value: 'POD', label: 'Proof of Delivery' },
  { value: 'Receipt', label: 'Receipt' },
  { value: 'BOL', label: 'Bill of Lading' },
  { value: 'Other', label: 'Other Document' },
]

const selectedType = ref(props.docType || 'POD')
const fileInput = ref(null)
const photoData = ref('')
const preview = ref('')
const uploading = ref(false)

watch(() => props.docType, (val) => {
  if (val) selectedType.value = val
})

const headerText = computed(() => {
  const labels = { POD: 'Upload Proof of Delivery', Receipt: 'Upload Receipt', BOL: 'Upload Bill of Lading', Other: 'Upload Document' }
  return labels[selectedType.value] || 'Upload Document'
})

const hintText = computed(() => {
  if (selectedType.value === 'Receipt') return `Take a photo of the receipt for Load ${props.loadId}`
  return `Take a photo or upload a file for Load ${props.loadId}`
})

function handlePhoto(event) {
  const file = event.target.files[0]
  if (!file) return

  const reader = new FileReader()
  reader.onload = (e) => {
    const img = new Image()
    img.onload = () => {
      const canvas = document.createElement('canvas')
      const MAX = 1200
      let w = img.width
      let h = img.height
      if (w > MAX || h > MAX) {
        if (w > h) {
          h = Math.round((h * MAX) / w)
          w = MAX
        } else {
          w = Math.round((w * MAX) / h)
          h = MAX
        }
      }
      canvas.width = w
      canvas.height = h
      canvas.getContext('2d').drawImage(img, 0, 0, w, h)
      photoData.value = canvas.toDataURL('image/jpeg', 0.8)
      preview.value = photoData.value
    }
    img.src = e.target.result
  }
  reader.readAsDataURL(file)
}

async function handleUpload() {
  if (!photoData.value || uploading.value) return
  uploading.value = true
  try {
    await api.post('/api/documents/upload', {
      loadId: props.loadId,
      rowIndex: props.rowIndex,
      docType: selectedType.value,
      photoData: photoData.value,
      driverName: props.driverName,
    })
    toast.show(`${selectedType.value} uploaded successfully`)
    emit('uploaded', { type: selectedType.value })
    photoData.value = ''
    preview.value = ''
    if (fileInput.value) fileInput.value.value = ''
  } catch (err) {
    toast.show(err.message || 'Failed to upload document', 'error')
  } finally {
    uploading.value = false
  }
}
</script>

<style scoped>
.doc-upload { margin-top: 1rem; }

.doc-header {
  font-weight: 600;
  font-size: 0.95rem;
  margin-bottom: 0.25rem;
}

.doc-hint {
  font-size: 0.82rem;
  color: var(--text-dim);
  margin-bottom: 0.75rem;
}

.type-select {
  width: 100%;
  padding: 0.5rem 0.65rem;
  border: 1px solid var(--border);
  border-radius: 6px;
  font-family: inherit;
  font-size: 0.85rem;
  background: var(--surface);
  color: var(--text);
  margin-bottom: 0.75rem;
  cursor: pointer;
}

.photo-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  min-height: 120px;
  border: 2px dashed var(--border);
  border-radius: var(--radius);
  cursor: pointer;
  margin-bottom: 0.75rem;
  font-size: 0.9rem;
  color: var(--text-dim);
  transition: border-color 0.15s;
  overflow: hidden;
}

.photo-btn:hover { border-color: var(--accent); }

.doc-preview {
  max-width: 100%;
  max-height: 200px;
  border-radius: var(--radius);
}

.btn-primary {
  width: 100%;
  padding: 0.7rem;
  background: var(--accent);
  color: #fff;
  border: none;
  border-radius: var(--radius);
  font-family: inherit;
  font-size: 0.9rem;
  font-weight: 600;
  cursor: pointer;
  transition: opacity 0.15s;
}

.btn-primary:hover { opacity: 0.9; }
.btn-primary:disabled { opacity: 0.4; cursor: not-allowed; }
</style>
