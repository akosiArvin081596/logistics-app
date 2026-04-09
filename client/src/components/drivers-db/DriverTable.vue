<template>
  <div class="card">
    <div class="admin-section-title">
      <div class="section-dot" style="background: var(--blue);"></div>
      Driver Directory
    </div>

    <EmptyState v-if="drivers.length === 0">No drivers yet.</EmptyState>

    <table v-else class="drv-table">
      <thead>
        <tr>
          <th>Driver</th>
          <th>Status</th>
          <th>Carrier</th>
          <th>Location</th>
          <th>Phone</th>
          <th>Email</th>
          <th>DOT</th>
          <th>MC</th>
          <th>Trucks</th>
          <th>Hazmat</th>
          <th>Rating</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="d in drivers" :key="d._rowIndex" class="clickable-row" @click="viewDrv = d">
          <td class="name-cell">{{ d[h.driver] || '\u2014' }}</td>
          <td>
            <span class="status-badge" :class="statusClass(d)">{{ (d.Status || 'active').toUpperCase() }}</span>
          </td>
          <td>{{ d[h.carrier] || '\u2014' }}</td>
          <td>{{ locStr(d) }}</td>
          <td>{{ d[h.phone] || '\u2014' }}</td>
          <td>{{ d[h.email] || '\u2014' }}</td>
          <td class="mono">{{ d[h.dot] || '\u2014' }}</td>
          <td class="mono">{{ d[h.mc] || '\u2014' }}</td>
          <td class="mono">{{ getAssignedTruck(d) }}</td>
          <td>{{ d[h.hazmat] || '\u2014' }}</td>
          <td>
            <template v-if="getDriverAvg(d)">
              <StarRating :model-value="Math.round(getDriverAvg(d).average)" readonly />
              <span style="font-size:0.7rem;color:#6b7280;margin-left:4px;">{{ getDriverAvg(d).average }} ({{ getDriverAvg(d).count }})</span>
            </template>
            <template v-else>{{ d[h.rating] || '\u2014' }}</template>
          </td>
          <td style="text-align:right;" @click.stop>
            <div class="action-btns">
              <button class="btn-edit" @click="openEdit(d)">Edit</button>
              <button class="btn-remove" @click="confirmDelete(d)">Remove</button>
            </div>
          </td>
        </tr>
      </tbody>
    </table>

    <!-- View Detail -->
    <Teleport to="body">
      <div v-if="viewDrv" class="confirm-overlay" @click.self="closeView">
        <div class="confirm-box" style="max-width:640px;max-height:85vh;overflow-y:auto;">
          <div class="view-header">
            <label class="view-avatar-wrap" :class="{ 'view-avatar-uploading': picUploading }" title="Click to change profile picture">
              <img v-if="viewDrv.ProfilePictureUrl" :src="viewDrv.ProfilePictureUrl" class="view-avatar-img" alt="Profile picture" />
              <div v-else class="view-avatar-initials">{{ initialsFor(viewDrv[h.driver]) }}</div>
              <div class="view-avatar-overlay">
                <svg v-if="!picUploading" xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>
                <div v-else class="view-spinner"></div>
              </div>
              <input type="file" accept="image/*" class="view-avatar-input" @change="onPicChange" />
            </label>
            <h3 style="margin:0;">{{ viewDrv[h.driver] }}</h3>
          </div>
          <div class="view-grid">
            <div v-for="col in viewHeaders" :key="col" class="view-row">
              <span class="view-label">{{ col }}</span>
              <span>{{ viewDrv[col] || '\u2014' }}</span>
            </div>
            <div v-if="docsData.ssn" class="view-row">
              <span class="view-label">SSN</span>
              <span class="ssn-value">
                {{ showSsn ? docsData.ssn : maskedSsn }}
                <button type="button" class="ssn-toggle" @click="showSsn = !showSsn" :title="showSsn ? 'Hide' : 'Show'">
                  <svg v-if="!showSsn" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                  <svg v-else xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
                </button>
              </span>
            </div>
          </div>

          <!-- Signed Onboarding Documents -->
          <div class="docs-section">
            <div class="docs-title">Signed Onboarding Documents</div>
            <div v-if="docsLoading" class="docs-empty">Loading...</div>
            <template v-else-if="docsData.linked === false">
              <div class="docs-empty">No onboarding record linked to this driver.</div>
            </template>
            <template v-else-if="docsData.documents && docsData.documents.length">
              <div v-for="doc in docsData.documents" :key="doc.doc_key" class="doc-row">
                <div class="doc-info">
                  <div class="doc-name">{{ doc.doc_name }}</div>
                  <div v-if="doc.signed" class="doc-meta">
                    Signed by <b>{{ doc.signature_text }}</b>
                    <span v-if="doc.signed_at"> · {{ new Date(doc.signed_at).toLocaleDateString() }}</span>
                  </div>
                  <div v-else class="doc-meta doc-pending">Not signed</div>
                </div>
                <a v-if="doc.signed && doc.signed_pdf_url" :href="doc.signed_pdf_url" target="_blank" class="doc-link">View PDF</a>
                <span v-else class="doc-pending-badge">Pending</span>
              </div>
            </template>
            <div v-else class="docs-empty">No signed documents.</div>
          </div>

          <!-- Drug Test -->
          <div class="docs-section">
            <div class="docs-title">Pre-Employment Drug Test</div>
            <div v-if="docsLoading" class="docs-empty">Loading...</div>
            <template v-else-if="docsData.drugTest">
              <div class="doc-row">
                <div class="doc-info">
                  <div class="doc-name">Drug Test Result</div>
                  <div class="doc-meta">
                    <span :class="docsData.drugTest.result === 'pass' ? 'dt-pass' : 'dt-fail'">
                      {{ docsData.drugTest.result.toUpperCase() }}
                    </span>
                    <span v-if="docsData.drugTest.uploaded_at"> · {{ new Date(docsData.drugTest.uploaded_at).toLocaleDateString() }}</span>
                  </div>
                </div>
                <a v-if="docsData.drugTest.file_url" :href="docsData.drugTest.file_url" target="_blank" class="doc-link">View File</a>
              </div>
            </template>
            <div v-else-if="docsData.linked !== false" class="docs-empty">No drug test uploaded yet.</div>
          </div>

          <!-- Shared Documents — Super Admin uploads files the driver sees in their Kit tab -->
          <LegalDocumentPortal v-if="viewDrv._rowIndex" :driver-id="viewDrv._rowIndex" />

          <div style="margin-top:1rem;text-align:right;">
            <button class="btn btn-secondary" @click="closeView">Close</button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- Edit Modal -->
    <Teleport to="body">
      <div v-if="showEdit" class="confirm-overlay" @click.self="showEdit = false">
        <div class="confirm-dialog edit-dialog">
          <h3>Edit Driver &mdash; {{ editForm.driver }}</h3>

          <div class="edit-row">
            <div class="edit-field">
              <label>Driver Name</label>
              <input v-model="editForm.driver" type="text" />
            </div>
            <div class="edit-field">
              <label>Carrier Name</label>
              <select v-model="editForm.carrierName">
                <option value="">-- Select --</option>
                <option v-for="name in carrierNames" :key="name" :value="name">{{ name }}</option>
              </select>
            </div>
          </div>

          <div class="edit-field">
            <label>Address</label>
            <input v-model="editForm.address" type="text" />
          </div>

          <div class="edit-row">
            <div class="edit-field">
              <label>City</label>
              <input v-model="editForm.city" type="text" />
            </div>
            <div class="edit-field">
              <label>State</label>
              <input v-model="editForm.state" type="text" maxlength="2" style="text-transform:uppercase;" />
            </div>
            <div class="edit-field">
              <label>ZIP</label>
              <input v-model="editForm.zip" type="text" />
            </div>
          </div>

          <div class="edit-row">
            <div class="edit-field">
              <label>Phone Number</label>
              <input v-model="editForm.phone" type="tel" />
            </div>
            <div class="edit-field">
              <label>Cell Number</label>
              <input v-model="editForm.cell" type="tel" />
            </div>
            <div class="edit-field">
              <label>Email</label>
              <input v-model="editForm.email" type="email" />
            </div>
          </div>

          <div class="edit-row">
            <div class="edit-field">
              <label>Trucks</label>
              <input v-model="editForm.trucks" type="text" />
            </div>
            <div class="edit-field">
              <label>Hazmat</label>
              <select v-model="editForm.hazmat">
                <option value="NO">NO</option>
                <option value="YES">YES</option>
              </select>
            </div>
          </div>

          <div class="edit-row">
            <div class="edit-field">
              <label>DOT #</label>
              <input v-model="editForm.dot" type="text" />
            </div>
            <div class="edit-field">
              <label>MC #</label>
              <input v-model="editForm.mc" type="text" />
            </div>
            <div class="edit-field">
              <label>Rating</label>
              <select v-model="editForm.rating">
                <option value="Not Rated">Not Rated</option>
                <option value="A+">A+</option>
                <option value="A">A</option>
                <option value="B">B</option>
                <option value="C">C</option>
                <option value="N/A">N/A</option>
              </select>
            </div>
          </div>

          <div class="edit-field">
            <label>Status</label>
            <select v-model="editForm.status">
              <option value="pending">Pending (awaiting drug test)</option>
              <option value="active">Active (can be dispatched)</option>
              <option value="inactive">Inactive (hidden from dispatch)</option>
            </select>
            <p class="status-help">Drivers become Active automatically after passing their drug test. Use this toggle to override.</p>
          </div>

          <div class="confirm-actions">
            <button class="btn btn-secondary" @click="showEdit = false">Cancel</button>
            <button class="btn btn-primary" @click="handleSaveEdit">Save</button>
          </div>
        </div>
      </div>
    </Teleport>

    <ConfirmModal
      :open="showConfirm"
      title="Delete Driver"
      :message="`Delete driver '${pendingDrv?.[h.driver] || ''}'? This action cannot be undone.`"
      confirm-text="Delete"
      :danger="true"
      @confirm="handleConfirmDelete"
      @cancel="showConfirm = false"
    />
  </div>
</template>

<script setup>
import { ref, reactive, computed, watch } from 'vue'
import { useApi } from '../../composables/useApi'
import EmptyState from '../shared/EmptyState.vue'
import ConfirmModal from '../shared/ConfirmModal.vue'
import StarRating from '../shared/StarRating.vue'
import LegalDocumentPortal from '../investor/LegalDocumentPortal.vue'

const api = useApi()

const props = defineProps({
  drivers: { type: Array, default: () => [] },
  headers: { type: Array, default: () => [] },
  carrierNames: { type: Array, default: () => [] },
  driverRatings: { type: Object, default: () => ({}) },
  truckAssignments: { type: Array, default: () => [] },
})

function getAssignedTruck(driver) {
  const driverCol = props.headers.find(h => /driver/i.test(h)) || props.headers[0]
  const name = (driver[driverCol] || '').trim().toLowerCase()
  if (!name) return '\u2014'
  const assignment = props.truckAssignments.find(a => (a.driver_name || '').toLowerCase() === name)
  if (!assignment) return '\u2014'
  return `${assignment.unit_number} (${assignment.year || ''} ${assignment.make || ''} ${assignment.model || ''})`.trim()
}

const emit = defineEmits(['delete', 'update', 'picture-updated'])

const viewDrv = ref(null)
const docsLoading = ref(false)
const docsData = reactive({ documents: [], drugTest: null, linked: true, ssn: null })
const showSsn = ref(false)
const showConfirm = ref(false)
const pendingDrv = ref(null)
const showEdit = ref(false)
const editRowIndex = ref(null)
const picUploading = ref(false)

function initialsFor(name) {
  return (name || '?')
    .split(/\s+/)
    .map(w => w[0])
    .join('')
    .toUpperCase()
    .slice(0, 2)
}

async function onPicChange(event) {
  const file = event.target.files?.[0]
  if (!file) return
  if (!viewDrv.value?._rowIndex) return
  picUploading.value = true
  try {
    const base64 = await resizeImageToBase64(file, 512)
    const res = await api.post(`/api/drivers-directory/${viewDrv.value._rowIndex}/profile-picture`, {
      fileData: base64,
      fileName: file.name,
    })
    // Update the current view and the row in props.drivers so both refresh
    viewDrv.value.ProfilePictureUrl = res.url
    emit('picture-updated')
  } catch (err) {
    // silent fail (toast not available here)
  } finally {
    picUploading.value = false
    event.target.value = ''
  }
}

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

const maskedSsn = computed(() => {
  const s = (docsData.ssn || '').replace(/\D/g, '')
  if (!s) return ''
  return s.length >= 4 ? `***-**-${s.slice(-4)}` : '***-**-****'
})

// Fetch signed docs + drug test + SSN when the detail modal opens
watch(viewDrv, async (d) => {
  docsData.documents = []
  docsData.drugTest = null
  docsData.linked = true
  docsData.ssn = null
  showSsn.value = false
  if (!d || !d._rowIndex) return
  docsLoading.value = true
  try {
    const res = await api.get(`/api/drivers-directory/${d._rowIndex}/documents`)
    docsData.documents = res.documents || []
    docsData.drugTest = res.drugTest || null
    docsData.linked = res.linked !== false
    docsData.ssn = res.ssn || null
  } catch { /* ignore */ }
  finally { docsLoading.value = false }
})

function closeView() {
  viewDrv.value = null
  showSsn.value = false
}

const h = computed(() => {
  const hd = props.headers
  const find = (re) => hd.find(c => re.test(c)) || ''
  return {
    driver: find(/^driver$/i),
    carrier: find(/carrier/i),
    state: find(/^state$/i),
    city: find(/^city$/i),
    zip: find(/^zip$/i),
    address: find(/^address$/i),
    trucks: find(/^trucks$/i),
    hazmat: find(/hazmat/i),
    phone: find(/phone/i),
    cell: find(/cell/i),
    email: find(/email/i),
    dot: find(/dot/i),
    mc: find(/^mc$/i),
    rating: find(/rating/i),
  }
})

const viewHeaders = computed(() => props.headers.filter(c => !/carrier/i.test(c)))

const editForm = reactive({
  driver: '', carrierName: '', state: '', city: '', zip: '', address: '',
  trucks: '', hazmat: 'NO', phone: '', cell: '', email: '',
  dot: '', mc: '', rating: 'Not Rated', status: 'active',
})

function statusClass(d) {
  const s = (d.Status || 'active').toLowerCase()
  if (s === 'active') return 'status-active'
  if (s === 'pending') return 'status-pending'
  return 'status-inactive'
}

function getDriverAvg(d) {
  const name = (d[h.value.driver] || '').trim().toLowerCase()
  if (!name) return null
  const r = props.driverRatings[name]
  return r && r.count > 0 ? r : null
}

function locStr(d) {
  const parts = [d[h.value.city], d[h.value.state]].filter(Boolean)
  return parts.length ? parts.join(', ') : '\u2014'
}

function openEdit(d) {
  editRowIndex.value = d._rowIndex
  editForm.driver = d[h.value.driver] || ''
  editForm.carrierName = d[h.value.carrier] || ''
  editForm.state = d[h.value.state] || ''
  editForm.city = d[h.value.city] || ''
  editForm.zip = d[h.value.zip] || ''
  editForm.address = d[h.value.address] || ''
  editForm.trucks = d[h.value.trucks] || ''
  editForm.hazmat = d[h.value.hazmat] || 'NO'
  editForm.phone = d[h.value.phone] || ''
  editForm.cell = d[h.value.cell] || ''
  editForm.email = d[h.value.email] || ''
  editForm.dot = d[h.value.dot] || ''
  editForm.mc = d[h.value.mc] || ''
  editForm.rating = d[h.value.rating] || 'Not Rated'
  editForm.status = d.Status || 'active'
  showEdit.value = true
}

function handleSaveEdit() {
  emit('update', {
    rowIndex: editRowIndex.value,
    values: [
      editForm.driver, editForm.carrierName, editForm.state, editForm.city,
      editForm.zip, editForm.address, editForm.trucks, editForm.hazmat,
      editForm.phone, editForm.cell, editForm.email,
      editForm.dot, editForm.mc, editForm.rating, editForm.status,
    ],
  })
  showEdit.value = false
}

function confirmDelete(d) {
  pendingDrv.value = d
  showConfirm.value = true
}

function handleConfirmDelete() {
  if (pendingDrv.value) emit('delete', pendingDrv.value._rowIndex)
  showConfirm.value = false
  pendingDrv.value = null
}
</script>

<style scoped>
.card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 1.25rem;
  margin-bottom: 1.25rem;
}
.admin-section-title {
  display: flex; align-items: center; gap: 0.5rem;
  font-weight: 700; font-size: 0.88rem; margin-bottom: 1rem;
}
.section-dot { width: 8px; height: 8px; border-radius: 50%; }

.drv-table {
  width: 100%; border-collapse: separate; border-spacing: 0;
  font-size: 0.82rem; margin-top: 0.5rem;
}
.drv-table th {
  text-align: left; padding: 0.6rem 0.5rem; font-weight: 600;
  color: var(--text-dim); border-bottom: 2px solid var(--border);
  font-size: 0.68rem; text-transform: uppercase; letter-spacing: 0.06em;
}
.drv-table td {
  padding: 0.65rem 0.5rem; border-bottom: 1px solid var(--bg); vertical-align: middle;
}
.drv-table tbody tr { transition: background 0.1s; }
.drv-table tbody tr:hover { background: var(--bg); }
.drv-table tbody tr:last-child td { border-bottom: none; }

.name-cell { font-weight: 600; }
.mono { font-family: 'JetBrains Mono', monospace; font-size: 0.78rem; }

.status-badge {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 0.62rem;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.status-badge.status-active { background: #dcfce7; color: #166534; }
.status-badge.status-pending { background: #fef3c7; color: #92400e; }
.status-badge.status-inactive { background: #f1f5f9; color: #64748b; }

.status-help {
  font-size: 0.68rem;
  color: #9ca3af;
  margin: 0.3rem 0 0;
  line-height: 1.4;
}

.action-btns { display: flex; gap: 0.35rem; justify-content: flex-end; }
.btn-edit, .btn-remove {
  padding: 0.3rem 0.65rem; font-size: 0.7rem; border-radius: 6px;
  border: 1px solid var(--border); background: var(--surface);
  cursor: pointer; font-family: inherit; font-weight: 500;
  color: var(--text-dim); transition: all 0.15s;
}
.btn-edit:hover { background: var(--blue-dim); color: var(--blue); border-color: var(--blue-dim); }
.btn-remove:hover { background: var(--danger-dim); color: var(--danger); border-color: var(--danger-dim); }

.confirm-overlay {
  position: fixed; inset: 0;
  background: rgba(0,0,0,0.3);
  display: flex; align-items: center; justify-content: center;
  z-index: 200;
}
.confirm-dialog {
  background: var(--surface); border-radius: var(--radius);
  padding: 1.5rem; max-width: 550px; width: 90%;
  box-shadow: 0 8px 30px rgba(0,0,0,0.12);
  max-height: 90vh; overflow-y: auto;
}
.confirm-dialog h3 { font-size: 1rem; margin-bottom: 1rem; }
.confirm-actions {
  display: flex; justify-content: flex-end; gap: 0.5rem; margin-top: 1.25rem;
}
.confirm-box {
  background: var(--surface); border-radius: var(--radius);
  padding: 1.5rem; width: 90%;
  box-shadow: 0 8px 30px rgba(0,0,0,0.12);
}

.edit-row { display: flex; gap: 1rem; }
.edit-row .edit-field { flex: 1; }
.edit-field { margin-bottom: 0.75rem; }
.edit-field label {
  display: block; font-size: 0.72rem; font-weight: 600;
  color: var(--text-dim); text-transform: uppercase;
  letter-spacing: 0.04em; margin-bottom: 0.3rem;
}
.edit-field select,
.edit-field input,
.edit-field textarea {
  width: 100%; padding: 0.5rem 0.65rem; border: 1px solid var(--border);
  border-radius: 6px; font-family: inherit; font-size: 0.82rem;
  background: var(--bg); color: var(--text); resize: vertical;
}
.edit-field select:focus,
.edit-field input:focus {
  outline: none; border-color: var(--blue);
}

.clickable-row { cursor: pointer; }
.clickable-row:hover td { background: var(--accent-dim, #f0f9ff); }
.view-header {
  display: flex;
  align-items: center;
  gap: 1rem;
  margin-bottom: 1rem;
}
.view-avatar-wrap {
  position: relative;
  width: 64px;
  height: 64px;
  flex-shrink: 0;
  cursor: pointer;
  border-radius: 50%;
  overflow: hidden;
}
.view-avatar-wrap .view-avatar-overlay { opacity: 0; }
.view-avatar-wrap:hover .view-avatar-overlay,
.view-avatar-wrap.view-avatar-uploading .view-avatar-overlay { opacity: 1; }
.view-avatar-img {
  width: 64px;
  height: 64px;
  border-radius: 50%;
  object-fit: cover;
  display: block;
}
.view-avatar-initials {
  width: 64px;
  height: 64px;
  border-radius: 50%;
  background: var(--accent-dim, #e0f2fe);
  color: var(--accent, #0ea5e9);
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 700;
  font-size: 1.3rem;
}
.view-avatar-overlay {
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
.view-avatar-input {
  position: absolute;
  inset: 0;
  opacity: 0;
  cursor: pointer;
  width: 100%;
  height: 100%;
}
.view-spinner {
  width: 20px;
  height: 20px;
  border: 2px solid rgba(255, 255, 255, 0.35);
  border-top-color: #fff;
  border-radius: 50%;
  animation: view-spin 0.7s linear infinite;
}
@keyframes view-spin { to { transform: rotate(360deg); } }
.view-grid { display: flex; flex-direction: column; gap: 0.4rem; }
.view-row { display: flex; justify-content: space-between; padding: 0.4rem 0; border-bottom: 1px solid #f1f5f9; font-size: 0.85rem; }
.view-label { font-weight: 600; color: var(--text-dim); font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.03em; }
.ssn-value {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.82rem;
  letter-spacing: 0.03em;
}
.ssn-toggle {
  background: transparent;
  border: none;
  padding: 0.2rem;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: #94a3b8;
  cursor: pointer;
  border-radius: 4px;
  transition: background 0.12s, color 0.12s;
}
.ssn-toggle:hover { background: #f1f5f9; color: #475569; }

.docs-section { margin-top: 1.25rem; padding-top: 1rem; border-top: 1px solid #e8edf2; }
.docs-title { font-size: 0.72rem; font-weight: 700; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 0.6rem; }
.docs-empty { font-size: 0.78rem; color: #9ca3af; padding: 0.5rem 0; }
.doc-row {
  display: flex; align-items: center; justify-content: space-between;
  padding: 0.55rem 0.75rem; background: #fafbfd; border: 1px solid #f1f5f9;
  border-radius: 8px; margin-bottom: 0.35rem;
}
.doc-info { flex: 1; min-width: 0; }
.doc-name { font-size: 0.82rem; font-weight: 600; color: #0f172a; }
.doc-meta { font-size: 0.72rem; color: #64748b; margin-top: 0.15rem; }
.doc-meta.doc-pending { color: #d97706; }
.doc-link {
  font-size: 0.72rem; font-weight: 600; color: #0ea5e9; text-decoration: none;
  padding: 0.35rem 0.7rem; border: 1px solid #bae6fd; border-radius: 6px;
  background: #f0f9ff; flex-shrink: 0;
}
.doc-link:hover { background: #e0f2fe; }
.doc-pending-badge {
  font-size: 0.68rem; font-weight: 700; color: #92400e; background: #fef3c7;
  padding: 0.25rem 0.6rem; border-radius: 999px; text-transform: uppercase;
}
.dt-pass { color: #16a34a; font-weight: 700; }
.dt-fail { color: #dc2626; font-weight: 700; }
</style>
