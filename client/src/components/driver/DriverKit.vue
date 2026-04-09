<template>
  <div v-if="!driverInfo && sharedDocuments.length === 0" class="empty-state">
    <div class="empty-icon">&#128196;</div>
    No driver profile found.
  </div>
  <div v-else>
    <div v-if="driverInfo" class="card">
      <div class="kit-header">
        <label class="kit-avatar-wrap" :class="{ 'kit-avatar-uploading': uploading }" :title="canUpload ? 'Click to change profile picture' : ''">
          <img v-if="profilePictureUrl" :src="profilePictureUrl" class="kit-avatar-img" alt="Profile picture" />
          <div v-else class="kit-avatar">{{ initials(displayName) }}</div>
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
  </div>
</template>

<script setup>
import { computed, ref } from 'vue'
import { useApi } from '../../composables/useApi'
import { useDriverStore } from '../../stores/driver'
import { useToast } from '../../composables/useToast'

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
})

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

function initials(name) {
  return (name || '?')
    .split(/\s+/)
    .map((w) => w[0])
    .join('')
    .toUpperCase()
    .slice(0, 2)
}

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
</style>
