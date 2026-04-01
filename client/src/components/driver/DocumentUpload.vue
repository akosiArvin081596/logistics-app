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

    <!-- File thumbnails -->
    <div v-if="files.length" class="photo-grid">
      <div v-for="(f, i) in files" :key="i" class="photo-thumb">
        <img v-if="f.isImage" :src="f.data" alt="Photo" />
        <div v-else class="doc-icon">
          <span class="doc-icon-emoji">&#128196;</span>
          <span class="doc-icon-name">{{ f.name }}</span>
        </div>
        <button class="thumb-remove" @click="removeFile(i)">&times;</button>
        <span class="thumb-num">{{ i + 1 }}</span>
      </div>
      <label class="photo-add">
        <input
          ref="addInput"
          type="file"
          accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.csv,.txt"
          hidden
          @change="handleFile"
        />
        <span>+</span>
      </label>
    </div>

    <!-- Initial capture/upload button -->
    <div v-else class="upload-buttons">
      <label class="photo-btn">
        <input
          ref="cameraInput"
          type="file"
          accept="image/*"
          capture="camera"
          hidden
          @change="handleFile"
        />
        <span>&#128247; Take Photo</span>
      </label>
      <label class="photo-btn">
        <input
          ref="fileInput"
          type="file"
          accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.csv,.txt"
          hidden
          @change="handleFile"
        />
        <span>&#128196; Upload File</span>
      </label>
    </div>

    <button
      class="btn btn-primary"
      :disabled="files.length === 0 || uploading"
      @click="handleUpload"
    >
      {{ uploading ? 'Uploading...' : `Upload ${selectedType} (${files.length} file${files.length !== 1 ? 's' : ''})` }}
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
const cameraInput = ref(null)
const fileInput = ref(null)
const addInput = ref(null)
const files = ref([]) // { data: base64, name: string, type: string, isImage: boolean }
const uploading = ref(false)

watch(() => props.docType, (val) => {
  if (val) selectedType.value = val
})

const headerText = computed(() => {
  const labels = { POD: 'Upload Proof of Delivery', Receipt: 'Upload Receipt', BOL: 'Upload Bill of Lading', Other: 'Upload Document' }
  return labels[selectedType.value] || 'Upload Document'
})

const hintText = computed(() => {
  if (selectedType.value === 'Receipt') return `Take photos of the receipt for Load ${props.loadId}`
  return `Take photos or upload files for Load ${props.loadId}`
})

function compressImage(file) {
  return new Promise((resolve) => {
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
        resolve(canvas.toDataURL('image/jpeg', 0.8))
      }
      img.onerror = () => {
        // If image can't be rendered (unsupported format), fall back to raw file
        resolve(e.target.result)
      }
      img.src = e.target.result
    }
    reader.readAsDataURL(file)
  })
}

function readFileAsDataURL(file) {
  return new Promise((resolve) => {
    const reader = new FileReader()
    reader.onload = (e) => resolve(e.target.result)
    reader.readAsDataURL(file)
  })
}

async function handleFile(event) {
  const file = event.target.files[0]
  if (!file) return

  if (file.type.startsWith('image/')) {
    const data = await compressImage(file)
    files.value.push({ data, name: file.name, type: file.type, isImage: true })
  } else {
    const data = await readFileAsDataURL(file)
    files.value.push({ data, name: file.name, type: file.type, isImage: false })
  }
  event.target.value = ''
}

function removeFile(index) {
  files.value.splice(index, 1)
}

async function handleUpload() {
  if (files.value.length === 0 || uploading.value) return
  uploading.value = true
  try {
    const images = files.value.filter(f => f.isImage)
    const docs = files.value.filter(f => !f.isImage)

    // Upload images as before (converted to multi-page PDF server-side)
    if (images.length > 0) {
      const photoData = images.length === 1 ? images[0].data : images.map(f => f.data)
      await api.post('/api/documents/upload', {
        loadId: props.loadId,
        rowIndex: props.rowIndex,
        docType: selectedType.value,
        photoData,
        driverName: props.driverName,
        fileType: 'image',
      })
    }

    // Upload each document file separately
    for (const doc of docs) {
      await api.post('/api/documents/upload', {
        loadId: props.loadId,
        rowIndex: props.rowIndex,
        docType: selectedType.value,
        photoData: doc.data,
        driverName: props.driverName,
        fileType: 'document',
        fileName: doc.name,
      })
    }

    const total = files.value.length
    toast.show(`${selectedType.value} uploaded (${total} file${total !== 1 ? 's' : ''})`)
    emit('uploaded', { type: selectedType.value })
    files.value = []
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

.upload-buttons {
  display: flex;
  gap: 0.5rem;
  margin-bottom: 0.75rem;
}

.photo-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 1;
  min-height: 80px;
  border: 2px dashed var(--border);
  border-radius: var(--radius);
  cursor: pointer;
  font-size: 0.85rem;
  color: var(--text-dim);
  transition: border-color 0.15s;
}

.photo-btn:hover { border-color: var(--accent); }

/* Photo/file grid */
.photo-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin-bottom: 0.75rem;
}
.photo-thumb {
  position: relative;
  width: 72px;
  height: 72px;
  border-radius: 8px;
  overflow: hidden;
  border: 1px solid var(--border);
}
.photo-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.doc-icon {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  background: var(--bg);
  padding: 0.2rem;
}
.doc-icon-emoji {
  font-size: 1.5rem;
  line-height: 1;
}
.doc-icon-name {
  font-size: 0.5rem;
  color: var(--text-dim);
  text-align: center;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  width: 100%;
  margin-top: 0.15rem;
}
.thumb-remove {
  position: absolute;
  top: 2px;
  right: 2px;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: rgba(0,0,0,0.6);
  color: #fff;
  border: none;
  font-size: 0.75rem;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  line-height: 1;
}
.thumb-num {
  position: absolute;
  bottom: 2px;
  left: 2px;
  background: rgba(0,0,0,0.5);
  color: #fff;
  font-size: 0.6rem;
  font-weight: 700;
  padding: 0.05rem 0.3rem;
  border-radius: 4px;
}
.photo-add {
  width: 72px;
  height: 72px;
  border: 2px dashed var(--border);
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  font-size: 1.5rem;
  color: var(--text-dim);
  transition: border-color 0.15s;
}
.photo-add:hover {
  border-color: var(--accent);
  color: var(--accent);
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
