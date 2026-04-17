<template>
  <div v-if="!driverInfo && sharedDocuments.length === 0 && truckDocuments.length === 0" class="empty-state">
    <div class="empty-icon">&#128196;</div>
    No driver profile found.
  </div>
  <div v-else>
    <div v-if="driverInfo" class="card">
      <div class="kit-header">
        <label class="kit-avatar-wrap" :class="{ 'kit-avatar-uploading': uploading }" :title="canUpload ? 'Click to change profile picture' : ''">
          <img v-if="profilePictureUrl" :src="profilePictureUrl" class="kit-avatar-img" alt="Profile picture" />
          <div v-else class="kit-avatar"><AvatarPlaceholder /></div>
          <div v-if="canUpload" class="kit-avatar-overlay">
            <svg v-if="!uploading" xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>
            <div v-else class="kit-spinner"></div>
          </div>
          <input v-if="canUpload" type="file" accept="image/*" class="kit-avatar-input" @change="onPicChange" />
        </label>
        <div>
          <div class="kit-name">{{ displayName }}</div>
          <div class="kit-role">Driver</div>
        </div>
      </div>
      <div
        v-for="row in visibleRows"
        :key="row.key"
        class="card-row"
      >
        <span class="card-label">{{ row.key }}</span>
        <span class="card-value">
          <a
            v-if="isUrl(row.value)"
            :href="row.value"
            target="_blank"
            rel="noopener"
            class="kit-link"
          >{{ row.value }}</a>
          <template v-else>{{ row.value }}</template>
        </span>
      </div>
    </div>

    <!-- My Identity Documents — CDL and medical card uploaded during the application -->
    <div v-if="identityFiles.length > 0" class="card kit-files-card">
      <div class="kit-files-header">
        <div class="kit-files-icon">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
        </div>
        <div class="kit-files-title">My Identity Documents</div>
        <span class="kit-files-count">{{ identityFiles.length }}</span>
      </div>
      <div class="kit-files-grid">
        <a v-for="(f, i) in identityFiles" :key="'id'+i" :href="f.data" :download="f.downloadName" target="_blank" rel="noopener" class="kit-file-card">
          <div v-if="f.type === 'image'" class="kit-file-thumb" :style="{ backgroundImage: `url(${f.data})` }"></div>
          <div v-else class="kit-file-thumb pdf">
            <svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>
          </div>
          <div class="kit-file-label">{{ f.label }}</div>
          <div class="kit-file-type">{{ f.type === 'pdf' ? 'PDF' : 'Image' }} &middot; tap to view</div>
        </a>
      </div>
    </div>

    <!-- Signed Contracts — onboarding documents the driver has already signed -->
    <div v-if="signedContracts.length > 0" class="card kit-files-card">
      <div class="kit-files-header">
        <div class="kit-files-icon">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
        </div>
        <div class="kit-files-title">Signed Contracts &amp; Agreements</div>
        <span class="kit-files-count">{{ signedContracts.length }}</span>
      </div>
      <div class="kit-files-grid">
        <a v-for="doc in signedContracts" :key="doc.doc_key" :href="doc.signed_pdf_url" target="_blank" rel="noopener" class="kit-file-card">
          <div class="kit-file-thumb pdf">
            <svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><path d="M9 15l2 2 4-4"/></svg>
          </div>
          <div class="kit-file-label">{{ doc.doc_name }}</div>
          <div class="kit-file-type">Signed {{ formatDate(doc.signed_at) }}</div>
        </a>
      </div>
    </div>

    <!-- Shared Documents — read-only files Super Admin uploaded through the drivers directory -->
    <div class="card shared-docs-card">
      <div class="shared-docs-header">
        <div class="shared-docs-icon">&#128196;</div>
        <div class="shared-docs-title">Shared Documents</div>
        <span v-if="sharedDocuments.length > 0" class="shared-docs-count">{{ sharedDocuments.length }}</span>
      </div>
      <div v-if="sharedDocuments.length === 0" class="shared-docs-empty">
        Your administrator hasn't shared any documents with you yet.
      </div>
      <div v-else class="shared-docs-list">
        <div v-for="doc in sharedDocuments" :key="doc.id" class="shared-doc-row">
          <div class="shared-doc-info">
            <div class="shared-doc-name">{{ doc.file_name }}</div>
            <div class="shared-doc-meta">
              <span class="shared-doc-type">{{ doc.doc_type }}</span>
              <span class="shared-doc-date">{{ formatDate(doc.uploaded_at) }}</span>
            </div>
            <div v-if="doc.notes" class="shared-doc-notes">{{ doc.notes }}</div>
          </div>
          <a
            :href="`/api/driver/shared-documents/${doc.id}/download`"
            target="_blank"
            rel="noopener"
            class="shared-doc-view"
          >View</a>
        </div>
      </div>
    </div>

    <!-- Truck Documents — admin-flagged docs from the truck currently assigned to this driver.
         View-only in the browser; no file_url ever reaches this component. -->
    <div v-if="truckDocuments.length > 0" class="card shared-docs-card">
      <div class="shared-docs-header">
        <div class="shared-docs-icon">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 3h15v13H1z"/><path d="M16 8h4l3 3v5h-7z"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/></svg>
        </div>
        <div class="shared-docs-title">Truck Documents</div>
        <span class="shared-docs-count">{{ truckDocuments.length }}</span>
      </div>
      <div class="shared-docs-hint">From your assigned truck. Tap View to open in a new tab.</div>
      <div class="shared-docs-list">
        <div v-for="doc in truckDocuments" :key="'t'+doc.id" class="shared-doc-row">
          <div class="shared-doc-info">
            <div class="shared-doc-name">{{ doc.file_name }}</div>
            <div class="shared-doc-meta">
              <span class="shared-doc-type">{{ doc.doc_type }}</span>
              <span class="shared-doc-date">{{ formatDate(doc.uploaded_at) }}</span>
            </div>
            <div v-if="doc.notes" class="shared-doc-notes">{{ doc.notes }}</div>
          </div>
          <a
            :href="`/api/driver/truck-documents/${doc.id}/view`"
            target="_blank"
            rel="noopener"
            class="shared-doc-view"
          >View</a>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, ref } from 'vue'
import { useApi } from '../../composables/useApi'
import { useDriverStore } from '../../stores/driver'
import { useToast } from '../../composables/useToast'
import AvatarPlaceholder from '../shared/AvatarPlaceholder.vue'

const api = useApi()
const driverStore = useDriverStore()
const toast = useToast()

const props = defineProps({
  driverInfo: { type: Object, default: null },
  headers: { type: Array, default: () => [] },
  sharedDocuments: { type: Array, default: () => [] },
  profilePictureUrl: { type: String, default: '' },
  driverId: { type: Number, default: 0 },
  canUpload: { type: Boolean, default: true },
  // The driver's original job application (minus SSN) for showing CDL /
  // medical card and other identity documents they submitted.
  application: { type: Object, default: null },
  // Signed onboarding PDFs (lease, contractor, W-9, etc.) — filtered to
  // non-confidential + signed on the frontend.
  onboardingDocuments: { type: Array, default: () => [] },
  // Docs uploaded to the driver's currently-assigned truck that admin
  // flagged as driver-visible. View-only — no file_url reaches the client.
  truckDocuments: { type: Array, default: () => [] },
})

// Flatten CDL front/back and medical card into a display list. Detects
// whether each upload is a PDF or an image from its data URI prefix.
const identityFiles = computed(() => {
  const out = []
  const app = props.application
  if (!app) return out
  const detect = (b64) => {
    if (!b64) return null
    if (b64.startsWith('data:application/pdf')) return 'pdf'
    if (b64.startsWith('data:image/')) return 'image'
    return null
  }
  const add = (label, b64) => {
    const type = detect(b64)
    if (!type) return
    out.push({
      label,
      type,
      data: b64,
      downloadName: `${label.replace(/\s+/g, '-')}.${type === 'pdf' ? 'pdf' : 'jpg'}`,
    })
  }
  add('CDL Front', app.cdl_front)
  add('CDL Back', app.cdl_back)
  add('Medical Card', app.medical_card)
  return out
})

// Only the contracts the driver has already signed, and only
// non-confidential ones (the confidentiality flag comes from the backend).
const signedContracts = computed(() =>
  (props.onboardingDocuments || []).filter(d => d.signed && d.signed_pdf_url)
)

const uploading = ref(false)

async function onPicChange(event) {
  const file = event.target.files?.[0]
  if (!file) return
  if (!props.driverId) {
    toast.show?.('Cannot upload — driver record not linked', 'error')
    return
  }
  uploading.value = true
  try {
    const base64 = await resizeImageToBase64(file, 512)
    await api.post(`/api/drivers-directory/${props.driverId}/profile-picture`, {
      fileData: base64,
      fileName: file.name,
    })
    await driverStore.loadData()
    toast.show?.('Profile picture updated', 'success')
  } catch (err) {
    toast.show?.('Upload failed', 'error')
  } finally {
    uploading.value = false
    event.target.value = ''
  }
}

// Resize an image file to a max dimension and return a JPEG data URL
function resizeImageToBase64(file, maxDim) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      let { width, height } = img
      if (width > maxDim || height > maxDim) {
        if (width > height) { height = Math.round(height * maxDim / width); width = maxDim }
        else { width = Math.round(width * maxDim / height); height = maxDim }
      }
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const ctx = canvas.getContext('2d')
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, width, height)
      ctx.drawImage(img, 0, 0, width, height)
      resolve(canvas.toDataURL('image/jpeg', 0.9))
    }
    img.onerror = reject
    img.src = URL.createObjectURL(file)
  })
}

function findCol(headers, regex) {
  return (headers || []).find((h) => regex.test(h)) || null
}

const driverCol = computed(() => findCol(props.headers, /driver/i) || props.headers[0])

const displayName = computed(() => {
  if (!props.driverInfo) return ''
  return props.driverInfo[driverCol.value] || ''
})

const visibleRows = computed(() => {
  if (!props.driverInfo) return []
  return props.headers
    .filter((h) => h !== '_rowIndex' && props.driverInfo[h])
    .map((h) => ({ key: h, value: props.driverInfo[h] }))
})


function isUrl(val) {
  return /^https?:\/\//i.test(val || '')
}

function formatDate(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  if (isNaN(d.getTime())) return ''
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}
</script>

<style scoped>
.kit-header {
  display: flex;
  align-items: center;
  gap: 1rem;
  margin-bottom: 1rem;
}

.kit-avatar-wrap {
  position: relative;
  width: 56px;
  height: 56px;
  flex-shrink: 0;
  cursor: pointer;
  border-radius: 50%;
  overflow: hidden;
  isolation: isolate;
}
.kit-avatar-wrap:not(.kit-avatar-uploading) .kit-avatar-overlay {
  opacity: 0;
}
.kit-avatar-wrap:hover .kit-avatar-overlay {
  opacity: 1;
}
.kit-avatar {
  width: 56px;
  height: 56px;
  border-radius: 50%;
  background: var(--accent-dim);
  color: var(--accent);
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 700;
  font-size: 1.2rem;
}
.kit-avatar-img {
  width: 56px;
  height: 56px;
  border-radius: 50%;
  object-fit: cover;
  display: block;
}
.kit-avatar-overlay {
  position: absolute;
  inset: 0;
  background: rgba(15, 23, 42, 0.55);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: opacity 0.15s;
  border-radius: 50%;
}
.kit-avatar-input {
  position: absolute;
  inset: 0;
  opacity: 0;
  cursor: pointer;
  width: 100%;
  height: 100%;
}
.kit-spinner {
  width: 18px;
  height: 18px;
  border: 2px solid rgba(255, 255, 255, 0.35);
  border-top-color: #fff;
  border-radius: 50%;
  animation: kit-spin 0.7s linear infinite;
}
@keyframes kit-spin { to { transform: rotate(360deg); } }

.kit-name {
  font-size: 1.1rem;
  font-weight: 700;
}

.kit-role {
  font-size: 0.78rem;
  color: var(--text-dim);
}

.card-row {
  display: flex;
  justify-content: space-between;
  padding: 0.35rem 0;
  font-size: 0.85rem;
  border-bottom: 1px solid var(--bg);
}

.card-row:last-child {
  border-bottom: none;
}

.card-label {
  color: var(--text-dim);
}

.card-value {
  font-weight: 500;
  text-align: right;
  max-width: 60%;
  word-break: break-word;
}

.kit-link {
  color: var(--accent);
  word-break: break-all;
}

.empty-icon {
  font-size: 2rem;
  margin-bottom: 0.5rem;
}

.shared-docs-card {
  margin-top: 1rem;
}
.shared-docs-header {
  display: flex;
  align-items: center;
  gap: 0.65rem;
  margin-bottom: 0.85rem;
}
.shared-docs-icon {
  width: 32px;
  height: 32px;
  border-radius: 8px;
  background: var(--accent-dim);
  color: var(--accent);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 1rem;
  flex-shrink: 0;
}
.shared-docs-title {
  font-size: 0.95rem;
  font-weight: 700;
  flex: 1;
}
.shared-docs-count {
  background: var(--accent-dim);
  color: var(--accent);
  font-size: 0.7rem;
  font-weight: 700;
  padding: 0.15rem 0.55rem;
  border-radius: 12px;
}
.shared-docs-empty {
  font-size: 0.82rem;
  color: var(--text-dim);
  padding: 0.5rem 0 0.25rem;
  font-style: italic;
}
.shared-docs-hint {
  font-size: 0.75rem;
  color: var(--text-dim);
  padding: 0 0 0.6rem;
}
.shared-docs-list {
  display: flex;
  flex-direction: column;
  gap: 0.55rem;
}
.shared-doc-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.75rem 0.85rem;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 10px;
}
.shared-doc-info {
  flex: 1;
  min-width: 0;
}
.shared-doc-name {
  font-size: 0.85rem;
  font-weight: 600;
  color: var(--text);
  word-break: break-word;
}
.shared-doc-meta {
  display: flex;
  align-items: center;
  gap: 0.55rem;
  margin-top: 0.25rem;
  font-size: 0.72rem;
  color: var(--text-dim);
}
.shared-doc-type {
  background: var(--accent-dim);
  color: var(--accent);
  padding: 0.1rem 0.5rem;
  border-radius: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  font-size: 0.65rem;
}
.shared-doc-notes {
  font-size: 0.72rem;
  color: var(--text-dim);
  margin-top: 0.3rem;
  font-style: italic;
}
.shared-doc-view {
  padding: 0.5rem 1rem;
  background: var(--accent);
  color: #fff;
  border-radius: 8px;
  text-decoration: none;
  font-size: 0.78rem;
  font-weight: 600;
  flex-shrink: 0;
  transition: opacity 0.15s;
}
.shared-doc-view:hover {
  opacity: 0.85;
}

/* My Identity Documents + Signed Contracts cards */
.kit-files-card {
  margin-bottom: 1rem;
}
.kit-files-header {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 0.9rem;
}
.kit-files-icon {
  width: 32px;
  height: 32px;
  border-radius: 8px;
  background: var(--accent-dim);
  color: var(--accent);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.kit-files-title {
  font-size: 0.92rem;
  font-weight: 700;
  color: var(--text);
  flex: 1;
}
.kit-files-count {
  font-size: 0.7rem;
  font-weight: 700;
  background: var(--accent-dim);
  color: var(--accent);
  padding: 0.15rem 0.55rem;
  border-radius: 99px;
}
.kit-files-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 0.65rem;
}
.kit-file-card {
  display: block;
  text-decoration: none;
  color: inherit;
  background: #fafbfd;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  padding: 0.55rem;
  transition: all 0.15s;
}
.kit-file-card:hover {
  border-color: var(--accent);
  background: var(--accent-dim);
  box-shadow: 0 2px 8px rgba(16, 185, 129, 0.08);
}
.kit-file-thumb {
  width: 100%;
  height: 96px;
  border-radius: 6px;
  background-color: #e2e8f0;
  background-size: cover;
  background-position: center;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #64748b;
  margin-bottom: 0.45rem;
}
.kit-file-thumb.pdf {
  background-color: #fef2f2;
  color: #dc2626;
}
.kit-file-thumb svg { display: block; }
.kit-file-label {
  font-size: 0.78rem;
  font-weight: 600;
  color: var(--text);
  margin-bottom: 0.15rem;
}
.kit-file-type {
  font-size: 0.68rem;
  color: var(--text-dim);
  font-family: 'JetBrains Mono', monospace;
}
</style>
