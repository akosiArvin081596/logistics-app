<template>
  <div class="section">
    <div class="section-title">
      <div class="section-icon" style="background: var(--blue-dim, rgba(59,130,246,0.15)); color: var(--blue, #3b82f6);">&#128196;</div>
      {{ isDriverMode ? 'Shared Documents' : 'Legal Documents' }}
      <span class="doc-count" v-if="docs.length > 0">{{ docs.length }}</span>
    </div>

    <!-- Upload (Super Admin + Investor) — hidden in read-only mode -->
    <div v-if="!readOnly" class="upload-row">
      <select v-if="isSuperAdmin && !truckId && !isDriverMode && trucks.length > 0" v-model="uploadForm.selectedTruckId" class="doc-select">
        <option :value="null">-- Profile Level --</option>
        <option v-for="t in trucks" :key="t.id" :value="t.id">{{ t.UnitNumber }}</option>
      </select>
      <select v-model="uploadForm.docType" class="doc-select">
        <option value="">-- Doc Type --</option>
        <option v-for="t in docTypes" :key="t" :value="t">{{ t }}</option>
      </select>
      <input v-model="uploadForm.notes" class="doc-input" type="text" placeholder="Notes (optional)" />
      <label class="upload-btn">
        {{ uploadForm.file ? uploadForm.file.name : 'Choose File' }}
        <input type="file" style="display:none" @change="onFileChange" />
      </label>
      <label v-if="canShareWithDriver" class="visible-toggle" title="Let the currently-assigned driver see this doc in their Driver Kit (view-only)">
        <input type="checkbox" v-model="uploadForm.visibleToDriver" />
        <span>Visible to assigned driver</span>
      </label>
      <button class="btn-upload" :disabled="!uploadForm.file || !uploadForm.docType || uploading" @click="upload">
        {{ uploading ? 'Uploading...' : 'Upload' }}
      </button>
    </div>

    <!-- Signed Onboarding Documents -->
    <div v-if="onboardingDocs.length > 0" class="onboarding-docs">
      <div class="ob-docs-label">Signed Onboarding Documents</div>
      <div class="ob-docs-grid">
        <a v-for="doc in onboardingDocs" :key="doc.doc_key" :href="doc.signed_pdf_url" target="_blank" rel="noopener" class="ob-doc-card">
          <div class="ob-doc-icon">
            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><path d="M9 15l2 2 4-4"/></svg>
          </div>
          <div class="ob-doc-name">{{ doc.doc_name }}</div>
          <div class="ob-doc-meta">Signed {{ fmtDate(doc.signed_at) }}</div>
        </a>
      </div>
    </div>

    <!-- Doc list -->
    <div v-if="loading" class="doc-empty">Loading...</div>
    <div v-else-if="docs.length === 0 && onboardingDocs.length === 0" class="doc-empty">No legal documents on file.</div>
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
          <td>
            <span class="type-badge">{{ doc.doc_type }}</span>
            <span v-if="doc.visible_to_driver === 1 && isTruckScoped(doc)" class="visible-badge" title="Visible in the assigned driver's Driver Kit">Driver</span>
          </td>
          <td class="file-name">{{ doc.file_name }}</td>
          <td class="notes-col">{{ doc.notes || '\u2014' }}</td>
          <td class="date-col">{{ fmtDate(doc.uploaded_at) }}</td>
          <td class="by-col">{{ doc.uploaded_by }}</td>
          <td>
            <a :href="doc.file_url" target="_blank" rel="noopener" class="btn-view">View</a>
            <button
              v-if="!readOnly && isSuperAdmin && isTruckScoped(doc)"
              class="btn-visibility"
              :class="{ active: doc.visible_to_driver === 1 }"
              :title="doc.visible_to_driver === 1 ? 'Hide from driver' : 'Show in Driver Kit'"
              :disabled="togglingId === doc.id"
              @click="toggleVisibility(doc)"
            >{{ doc.visible_to_driver === 1 ? 'Hide' : 'Show driver' }}</button>
            <button v-if="!readOnly && (isSuperAdmin || doc.uploaded_by === auth.user?.username)" class="btn-del" @click="remove(doc)">&#x2715;</button>
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
  trucks: { type: Array, default: () => [] },
  investorId: { type: Number, default: null },
  driverId: { type: Number, default: null },
  readOnly: { type: Boolean, default: false },
})

const api = useApi()
const auth = useAuthStore()

const isSuperAdmin = computed(() => auth.user?.role === 'Super Admin')
const isDriverMode = computed(() => !!props.driverId)

// Master doc-type list — kept in sync with server.js validTypes array
const docTypes = [
  'Title', 'Registration', 'Insurance Certificate', 'Lease Agreement',
  'Bill of Sale', 'Inspection Report', 'IFTA License', 'Maintenance Records',
  'Photo', 'Contract', 'Tax Document', 'Compliance',
  "Driver's License", 'Medical Card', 'ID Card',
  'Other',
]

const docs = ref([])
const onboardingDocs = ref([])
const loading = ref(false)
const uploading = ref(false)
const errorMsg = ref('')

const uploadForm = reactive({
  docType: '',
  notes: '',
  file: null,
  fileBase64: '',
  selectedTruckId: null,
  visibleToDriver: false,
})

// Driver visibility only makes sense for truck-scoped uploads. In truck modal
// mode (truckId is set) it's always available; in investor-profile mode it
// activates only when the admin has picked a specific truck from the dropdown.
const canShareWithDriver = computed(() => {
  if (isDriverMode.value) return false
  if (props.truckId) return true
  if (isSuperAdmin.value && uploadForm.selectedTruckId) return true
  return false
})

const togglingId = ref(0)

function isTruckScoped(doc) {
  return doc && doc.truck_id > 0 && !(doc.driver_id > 0) && !(doc.investor_id > 0)
}

async function toggleVisibility(doc) {
  if (!isTruckScoped(doc)) return
  const next = doc.visible_to_driver === 1 ? 0 : 1
  const prev = doc.visible_to_driver
  doc.visible_to_driver = next // optimistic
  togglingId.value = doc.id
  try {
    await api.patch(`/api/legal-documents/${doc.id}/visibility`, { visibleToDriver: next === 1 })
  } catch {
    doc.visible_to_driver = prev // rollback
    errorMsg.value = 'Visibility update failed.'
  } finally {
    togglingId.value = 0
  }
}

async function load() {
  loading.value = true
  try {
    let params = ''
    if (props.driverId) params = `?driver_id=${props.driverId}`
    else if (props.truckId) params = `?truck_id=${props.truckId}`
    else if (props.unitNumber) params = `?unit_number=${encodeURIComponent(props.unitNumber)}`
    else if (props.investorId) params = `?investor_id=${props.investorId}`
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
  // Driver-mode uploads never attach truck/investor context — the row is tagged only with driver_id server-side
  const activeTruckId = props.driverId ? 0 : (props.truckId || uploadForm.selectedTruckId || 0)
  const activeTruck = props.driverId ? null : props.trucks.find(t => t.id === activeTruckId)
  const activeUnitNumber = props.driverId ? '' : (props.unitNumber || activeTruck?.UnitNumber || '')
  uploading.value = true
  errorMsg.value = ''
  try {
    await api.post('/api/legal-documents/upload', {
      truckId: activeTruckId,
      unitNumber: activeUnitNumber,
      docType: uploadForm.docType,
      fileName: uploadForm.file.name,
      fileData: uploadForm.fileBase64,
      notes: uploadForm.notes,
      uploadedBy: auth.user?.username || 'admin',
      investorId: props.driverId ? undefined : (props.investorId || undefined),
      driverId: props.driverId || undefined,
      visibleToDriver: canShareWithDriver.value ? uploadForm.visibleToDriver : false,
    })
    uploadForm.file = null
    uploadForm.fileBase64 = ''
    uploadForm.docType = ''
    uploadForm.notes = ''
    uploadForm.selectedTruckId = null
    uploadForm.visibleToDriver = false
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

async function loadOnboardingDocs() {
  try {
    const params = props.investorId ? `?investor_id=${props.investorId}` : ''
    const res = await api.get(`/api/investor/onboarding-documents${params}`)
    onboardingDocs.value = (res.documents || []).filter(d => d.signed && d.signed_pdf_url)
  } catch { /* skip */ }
}

onMounted(() => {
  load()
  // Only show onboarding docs on investor profile view (not truck-specific modals, not driver modals)
  if (!props.truckId && !props.unitNumber && !props.driverId) loadOnboardingDocs()
})
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
.btn-upload:disabled { opacity: 0.5; cursor: not-allowed; background: #9ca3af; }
.upload-hint { font-size: 0.72rem; color: #f59e0b; font-weight: 500; white-space: nowrap; }

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

.visible-toggle {
  display: inline-flex; align-items: center; gap: 0.35rem;
  padding: 0.35rem 0.6rem; background: var(--surface);
  border: 1px solid var(--border); border-radius: 6px;
  font-size: 0.75rem; color: var(--text-dim); cursor: pointer;
  user-select: none; white-space: nowrap;
}
.visible-toggle input[type="checkbox"] { accent-color: var(--accent); cursor: pointer; margin: 0; }
.visible-toggle:hover { border-color: var(--accent); color: var(--accent); }

.visible-badge {
  display: inline-flex; padding: 0.12rem 0.5rem; margin-left: 0.4rem;
  border-radius: 10px; font-size: 0.62rem; font-weight: 700;
  letter-spacing: 0.04em; text-transform: uppercase;
  background: rgba(16, 185, 129, 0.14); color: #059669;
}
.btn-visibility {
  padding: 0.2rem 0.55rem; font-size: 0.7rem; border-radius: 5px;
  background: transparent; color: var(--text-dim);
  border: 1px solid var(--border); cursor: pointer; font-weight: 600;
  margin-right: 0.35rem; transition: all 0.15s;
}
.btn-visibility:hover { border-color: var(--accent); color: var(--accent); }
.btn-visibility.active {
  background: rgba(16, 185, 129, 0.12); color: #059669; border-color: #a7f3d0;
}
.btn-visibility:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-del {
  padding: 0.2rem 0.45rem; font-size: 0.7rem; border-radius: 5px;
  background: var(--danger-dim); color: var(--danger);
  border: none; cursor: pointer; font-weight: 600; transition: opacity 0.15s;
}
.btn-del:hover { opacity: 0.75; }

.error-msg { color: var(--danger); font-size: 0.78rem; margin-top: 0.5rem; }

.onboarding-docs { margin-bottom: 1rem; }
.ob-docs-label {
  font-size: 0.72rem; font-weight: 700; color: #64748b;
  text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 0.6rem;
}
.ob-docs-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 0.65rem; }
.ob-doc-card {
  display: flex; flex-direction: column; align-items: center; gap: 0.4rem;
  padding: 1rem 0.75rem; border: 1.5px solid #d1fae5; border-radius: 10px;
  background: #f7fdf9; text-decoration: none; color: inherit;
  transition: all 0.15s; cursor: pointer; text-align: center;
}
.ob-doc-card:hover { border-color: #16a34a; background: #ecfdf5; transform: translateY(-1px); box-shadow: 0 2px 8px rgba(0,0,0,0.06); }
.ob-doc-icon { color: #16a34a; }
.ob-doc-name { font-size: 0.78rem; font-weight: 600; color: #0f172a; line-height: 1.3; }
.ob-doc-meta { font-size: 0.65rem; color: #94a3b8; }
</style>
