<template>
  <div class="section">
    <div class="section-title">
      <div class="section-icon" style="background: var(--blue-dim, rgba(59,130,246,0.15)); color: var(--blue, #3b82f6);">&#128196;</div>
      Legal Documents
      <span class="doc-count" v-if="docs.length > 0">{{ docs.length }}</span>
    </div>

    <!-- Upload (Super Admin only) -->
    <div v-if="isSuperAdmin" class="upload-row">
      <select v-model="uploadForm.docType" class="doc-select">
        <option value="">-- Doc Type --</option>
        <option v-for="t in docTypes" :key="t" :value="t">{{ t }}</option>
      </select>
      <input v-model="uploadForm.notes" class="doc-input" type="text" placeholder="Notes (optional)" />
      <label class="upload-btn">
        {{ uploadForm.file ? uploadForm.file.name : 'Choose File' }}
        <input type="file" style="display:none" @change="onFileChange" />
      </label>
      <button class="btn-upload" :disabled="!uploadForm.file || !uploadForm.docType || uploading" @click="upload">
        {{ uploading ? 'Uploading...' : 'Upload' }}
      </button>
    </div>

    <!-- Doc list -->
    <div v-if="loading" class="doc-empty">Loading...</div>
    <div v-else-if="docs.length === 0" class="doc-empty">No legal documents on file.</div>
    <table v-else class="doc-table">
      <thead>
        <tr>
          <th>Type</th>
          <th>File</th>
          <th>Notes</th>
          <th>Uploaded</th>
          <th>By</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="doc in docs" :key="doc.id">
          <td><span class="type-badge">{{ doc.doc_type }}</span></td>
          <td class="file-name">{{ doc.file_name }}</td>
          <td class="notes-col">{{ doc.notes || '\u2014' }}</td>
          <td class="date-col">{{ fmtDate(doc.uploaded_at) }}</td>
          <td class="by-col">{{ doc.uploaded_by }}</td>
          <td>
            <a :href="doc.file_url" target="_blank" rel="noopener" class="btn-view">View</a>
            <button v-if="isSuperAdmin" class="btn-del" @click="remove(doc)">&#x2715;</button>
          </td>
        </tr>
      </tbody>
    </table>

    <div v-if="errorMsg" class="error-msg">{{ errorMsg }}</div>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted, computed } from 'vue'
import { useApi } from '../../composables/useApi'
import { useAuthStore } from '../../stores/auth'

const props = defineProps({
  truckId: { type: Number, default: null },
  unitNumber: { type: String, default: '' },
})

const api = useApi()
const auth = useAuthStore()

const isSuperAdmin = computed(() => auth.user?.role === 'Super Admin')

const docTypes = [
  'Title', 'Registration', 'Insurance Certificate', 'Lease Agreement',
  'Bill of Sale', 'Inspection Report', 'IFTA License', 'Other',
]

const docs = ref([])
const loading = ref(false)
const uploading = ref(false)
const errorMsg = ref('')

const uploadForm = reactive({
  docType: '',
  notes: '',
  file: null,
  fileBase64: '',
})

async function load() {
  loading.value = true
  try {
    const params = props.truckId ? `?truck_id=${props.truckId}` : props.unitNumber ? `?unit_number=${encodeURIComponent(props.unitNumber)}` : ''
    const res = await api.get(`/api/legal-documents${params}`)
    docs.value = res.documents || []
  } catch {
    errorMsg.value = 'Failed to load documents.'
  } finally {
    loading.value = false
  }
}

function onFileChange(e) {
  const file = e.target.files[0]
  if (!file) return
  uploadForm.file = file
  const reader = new FileReader()
  reader.onload = ev => { uploadForm.fileBase64 = ev.target.result }
  reader.readAsDataURL(file)
}

async function upload() {
  if (!uploadForm.file || !uploadForm.docType) return
  uploading.value = true
  errorMsg.value = ''
  try {
    await api.post('/api/legal-documents', {
      truckId: props.truckId,
      unitNumber: props.unitNumber,
      docType: uploadForm.docType,
      fileName: uploadForm.file.name,
      fileData: uploadForm.fileBase64,
      notes: uploadForm.notes,
      uploadedBy: auth.user?.username || 'admin',
    })
    uploadForm.file = null
    uploadForm.fileBase64 = ''
    uploadForm.docType = ''
    uploadForm.notes = ''
    await load()
  } catch {
    errorMsg.value = 'Upload failed.'
  } finally {
    uploading.value = false
  }
}

async function remove(doc) {
  if (!confirm(`Delete "${doc.file_name}"?`)) return
  try {
    await api.delete(`/api/legal-documents/${doc.id}`)
    docs.value = docs.value.filter(d => d.id !== doc.id)
  } catch {
    errorMsg.value = 'Delete failed.'
  }
}

function fmtDate(ts) {
  if (!ts) return '\u2014'
  return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

onMounted(load)
</script>

<style scoped>
.section {
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius); padding: 1.25rem; margin-bottom: 1.25rem;
}
.section-title {
  font-size: 0.95rem; font-weight: 700; margin-bottom: 1rem;
  display: flex; align-items: center; gap: 0.5rem;
}
.section-icon {
  width: 28px; height: 28px; border-radius: 8px;
  display: flex; align-items: center; justify-content: center; font-size: 0.9rem;
}
.doc-count {
  background: var(--border); color: var(--text-dim);
  font-size: 0.65rem; font-weight: 700; padding: 0.1rem 0.45rem;
  border-radius: 10px;
}

.upload-row {
  display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap;
  margin-bottom: 1rem; padding: 0.75rem; background: var(--bg);
  border-radius: 8px; border: 1px solid var(--border);
}
.doc-select, .doc-input {
  padding: 0.4rem 0.6rem; border: 1px solid var(--border); border-radius: 6px;
  background: var(--surface); color: var(--text); font-family: inherit;
  font-size: 0.8rem;
}
.doc-select { min-width: 160px; }
.doc-input { flex: 1; min-width: 120px; }
.upload-btn {
  padding: 0.4rem 0.85rem; border: 1px solid var(--border); border-radius: 6px;
  background: var(--surface); color: var(--text-dim); font-size: 0.78rem;
  cursor: pointer; white-space: nowrap; font-family: inherit;
  transition: all 0.15s;
}
.upload-btn:hover { border-color: var(--accent); color: var(--accent); }
.btn-upload {
  padding: 0.4rem 1rem; background: var(--accent); color: #fff;
  border: none; border-radius: 6px; font-family: inherit; font-size: 0.8rem;
  font-weight: 600; cursor: pointer; white-space: nowrap; transition: opacity 0.15s;
}
.btn-upload:disabled { opacity: 0.35; cursor: not-allowed; }

.doc-empty { text-align: center; color: var(--text-dim); font-size: 0.82rem; padding: 1.5rem 0; }

.doc-table {
  width: 100%; border-collapse: separate; border-spacing: 0; font-size: 0.82rem;
}
.doc-table th {
  text-align: left; padding: 0.5rem 0.5rem; font-weight: 600;
  color: var(--text-dim); border-bottom: 2px solid var(--border);
  font-size: 0.66rem; text-transform: uppercase; letter-spacing: 0.06em;
}
.doc-table td {
  padding: 0.6rem 0.5rem; border-bottom: 1px solid var(--bg); vertical-align: middle;
}
.doc-table tbody tr:hover { background: var(--bg); }

.type-badge {
  display: inline-flex; padding: 0.15rem 0.55rem; border-radius: 10px;
  font-size: 0.68rem; font-weight: 600;
  background: var(--blue-dim, rgba(59,130,246,0.12)); color: var(--blue, #3b82f6);
}
.file-name { font-family: 'JetBrains Mono', monospace; font-size: 0.75rem; }
.notes-col { color: var(--text-dim); font-size: 0.78rem; max-width: 180px; }
.date-col { color: var(--text-dim); font-size: 0.75rem; white-space: nowrap; }
.by-col { color: var(--text-dim); font-size: 0.75rem; }

.btn-view {
  padding: 0.2rem 0.55rem; font-size: 0.7rem; border-radius: 5px;
  background: var(--accent-dim); color: var(--accent);
  text-decoration: none; font-weight: 600; margin-right: 0.35rem;
  transition: opacity 0.15s;
}
.btn-view:hover { opacity: 0.75; }
.btn-del {
  padding: 0.2rem 0.45rem; font-size: 0.7rem; border-radius: 5px;
  background: var(--danger-dim); color: var(--danger);
  border: none; cursor: pointer; font-weight: 600; transition: opacity 0.15s;
}
.btn-del:hover { opacity: 0.75; }

.error-msg { color: var(--danger); font-size: 0.78rem; margin-top: 0.5rem; }
</style>
