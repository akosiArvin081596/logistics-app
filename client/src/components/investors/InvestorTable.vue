<template>
  <div class="card">
    <div class="admin-section-title">
      <div class="section-dot" style="background: var(--blue);"></div>
      Investor Directory
    </div>

    <EmptyState v-if="investors.length === 0">No investors yet.</EmptyState>

    <table v-else class="inv-table">
      <thead>
        <tr>
          <th>Investor Name</th>
          <th>Carrier Name</th>
          <th>Trucks</th>
          <th>Status</th>
          <th>Notes</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="inv in investors" :key="inv.id" class="clickable-row" @click="viewDetail(inv)">
          <td class="name-cell">{{ inv.fullName }}</td>
          <td>{{ inv.carrierName || '\u2014' }}</td>
          <td class="mono">{{ inv.truckCount }}</td>
          <td>
            <span :class="['status-badge', inv.status === 'Active' ? 'status-active' : 'status-inactive']">{{ inv.status }}</span>
          </td>
          <td class="notes-cell">{{ inv.notes || '\u2014' }}</td>
          <td style="text-align:right;">
            <div class="action-btns">
              <button class="btn-edit" @click.stop="openEdit(inv)">Edit</button>
              <button class="btn-remove" @click.stop="confirmDelete(inv)">Remove</button>
            </div>
          </td>
        </tr>
      </tbody>
    </table>

    <!-- Edit Modal -->
    <Teleport to="body">
      <div v-if="showEdit" class="confirm-overlay" @click.self="showEdit = false">
        <div class="confirm-dialog">
          <h3>Edit Investor &mdash; {{ editForm.fullName }}</h3>

          <div class="edit-row">
            <div class="edit-field">
              <label>Investor Name</label>
              <input v-model="editForm.fullName" type="text" />
            </div>
            <div class="edit-field">
              <label>Carrier Name</label>
              <select v-model="editForm.carrierName">
                <option value="">-- Select carrier --</option>
                <option v-for="name in carrierNames" :key="name" :value="name">{{ name }}</option>
              </select>
            </div>
          </div>

          <div class="edit-row">
            <div class="edit-field">
              <label>Status</label>
              <select v-model="editForm.status">
                <option value="Active">Active</option>
                <option value="Inactive">Inactive</option>
              </select>
            </div>
          </div>

          <div class="edit-field">
            <label>Notes</label>
            <textarea v-model="editForm.notes" rows="2"></textarea>
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
      title="Delete Investor"
      :message="`Delete investor '${pendingInv?.fullName || ''}'? This action cannot be undone.`"
      confirm-text="Delete"
      :danger="true"
      @confirm="handleConfirmDelete"
      @cancel="showConfirm = false"
    />
    <!-- Detail Modal -->
    <Teleport to="body">
      <div v-if="showDetail" style="position:fixed;inset:0;background:rgba(0,0,0,0.4);display:flex;align-items:center;justify-content:center;z-index:9999" @click.self="showDetail = false">
        <div style="background:#fff;border-radius:14px;max-width:680px;width:90%;max-height:90vh;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 25px 50px rgba(0,0,0,0.2)">
          <div style="display:flex;justify-content:space-between;align-items:center;padding:1rem 1.5rem;border-bottom:1px solid #e8edf2">
            <div style="display:flex;align-items:center;gap:1rem;flex:1;min-width:0">
              <label class="inv-avatar-wrap" :class="{ 'inv-avatar-uploading': picUploading }" title="Click to change profile picture">
                <img v-if="detail.profilePictureUrl" :src="detail.profilePictureUrl" class="inv-avatar-img" alt="Profile picture" />
                <div v-else class="inv-avatar-initials">{{ modalInitials }}</div>
                <div class="inv-avatar-overlay">
                  <svg v-if="!picUploading" xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>
                  <div v-else class="inv-spinner"></div>
                </div>
                <input type="file" accept="image/*" class="inv-avatar-input" @change="onPicChange" />
              </label>
              <div style="flex:1;min-width:0">
                <div style="font-size:1.1rem;font-weight:700;color:#0f172a">{{ detail.application?.legal_name || 'Investor' }}</div>
                <div style="font-size:13px;color:#94a3b8">{{ detail.application?.entity_type }} | {{ detail.application?.email }}</div>
              </div>
            </div>
            <button style="font-size:1.5rem;background:none;border:none;cursor:pointer;color:#94a3b8;line-height:1" @click="showDetail = false">&times;</button>
          </div>
          <div v-if="detailLoading" style="display:flex;align-items:center;justify-content:center;padding:4rem">
            <span style="font-size:13px;color:#94a3b8">Loading...</span>
          </div>
          <div v-else-if="detail.application" style="padding:1.25rem 1.5rem;overflow-y:auto;max-height:68vh">
            <!-- Company & Business -->
            <div class="detail-section">
              <div class="detail-section-title"><svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg> Company &amp; Business</div>
              <div class="detail-grid">
                <div class="detail-item"><span class="detail-label">Legal Name</span><span class="detail-value">{{ detail.application.legal_name }}</span></div>
                <div v-if="detail.application.dba" class="detail-item"><span class="detail-label">DBA</span><span class="detail-value">{{ detail.application.dba }}</span></div>
                <div v-if="detail.application.entity_type" class="detail-item"><span class="detail-label">Entity Type</span><span class="detail-value">{{ detail.application.entity_type }}</span></div>
                <div v-if="detail.application.tax_classification" class="detail-item"><span class="detail-label">Tax Classification</span><span class="detail-value">{{ detail.application.tax_classification }}</span></div>
                <div v-if="detail.application.ein_ssn" class="detail-item"><span class="detail-label">EIN/SSN</span><span class="detail-value">{{ detail.application.ein_ssn }}</span></div>
                <div v-if="detail.application.years_in_operation" class="detail-item"><span class="detail-label">Years in Operation</span><span class="detail-value">{{ detail.application.years_in_operation }}</span></div>
                <div v-if="detail.application.industry_experience" class="detail-item"><span class="detail-label">Industry Experience</span><span class="detail-value">{{ detail.application.industry_experience }}</span></div>
                <div v-if="detail.application.fleet_size" class="detail-item"><span class="detail-label">Fleet Size</span><span class="detail-value">{{ detail.application.fleet_size }}</span></div>
                <div class="detail-item full"><span class="detail-label">Address</span><span class="detail-value">{{ detail.application.address }}</span></div>
                <div v-if="detail.application.bankruptcy_liens" class="detail-item full"><span class="detail-label">Bankruptcy / Liens</span><span class="detail-value">{{ detail.application.bankruptcy_liens }}</span></div>
              </div>
            </div>

            <!-- Key Contact Person -->
            <div class="detail-section">
              <div class="detail-section-title"><svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg> Key Contact</div>
              <div class="detail-grid">
                <div v-if="detail.application.contact_person" class="detail-item"><span class="detail-label">Contact Person</span><span class="detail-value">{{ detail.application.contact_person }}</span></div>
                <div v-if="detail.application.contact_title" class="detail-item"><span class="detail-label">Title</span><span class="detail-value">{{ detail.application.contact_title }}</span></div>
                <div v-if="detail.application.phone" class="detail-item"><span class="detail-label">Phone</span><span class="detail-value">{{ detail.application.phone }}</span></div>
                <div v-if="detail.application.email" class="detail-item"><span class="detail-label">Email</span><span class="detail-value">{{ detail.application.email }}</span></div>
                <div v-if="detail.application.preferred_communication" class="detail-item"><span class="detail-label">Preferred Contact Method</span><span class="detail-value">{{ detail.application.preferred_communication }}</span></div>
                <div v-if="detail.application.reporting_preference" class="detail-item"><span class="detail-label">Monthly Statement Delivery</span><span class="detail-value">{{ detail.application.reporting_preference }}</span></div>
              </div>
            </div>
            <!-- Fleet -->
            <div v-if="detail.vehicles.length" class="detail-section">
              <div class="detail-section-title"><svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="3" width="15" height="13"/><polygon points="16 8 20 8 23 11 23 16 16 16 16 8"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/></svg> Fleet ({{ detail.vehicles.length }} vehicle{{ detail.vehicles.length > 1 ? 's' : '' }})</div>
              <div v-for="(v, i) in detail.vehicles" :key="i" style="margin-bottom:0.5rem;padding:0.65rem;background:#fafbfd;border-radius:8px;border:1px solid #f1f5f9">
                <div style="font-size:11px;font-weight:700;color:#94a3b8;text-transform:uppercase;margin-bottom:0.4rem">Vehicle {{ String.fromCharCode(65 + i) }}</div>
                <div class="detail-grid">
                  <div class="detail-item"><span class="detail-label">Make</span><span class="detail-value">{{ v.make }}</span></div>
                  <div class="detail-item"><span class="detail-label">Model</span><span class="detail-value">{{ v.model }}</span></div>
                  <div class="detail-item"><span class="detail-label">Year</span><span class="detail-value">{{ v.year }}</span></div>
                  <div class="detail-item"><span class="detail-label">VIN</span><span class="detail-value">{{ v.vin }}</span></div>
                  <div v-if="v.licensePlate" class="detail-item"><span class="detail-label">License Plate</span><span class="detail-value">{{ v.licensePlate }}</span></div>
                  <div v-if="v.purchasePrice" class="detail-item"><span class="detail-label">Purchase Price</span><span class="detail-value">${{ Number(v.purchasePrice).toLocaleString() }}</span></div>
                </div>
              </div>
            </div>
            <!-- Documents -->
            <div v-if="detail.documents.length" class="detail-section">
              <div class="detail-section-title"><svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg> Documents ({{ detail.documents.filter(d => d.signed).length }}/{{ detail.documents.length }} signed)</div>
              <div class="detail-grid">
                <div v-for="doc in detail.documents" :key="doc.doc_key" class="detail-item full">
                  <span class="detail-label">{{ doc.doc_name }}</span>
                  <span v-if="doc.signed && doc.signed_pdf_url" class="detail-value" style="color:#16a34a;cursor:pointer" @click="openPdf(doc.signed_pdf_url)">Signed by {{ doc.signature_text }} — View PDF</span>
                  <span v-else-if="doc.signed" class="detail-value" style="color:#16a34a">Signed by {{ doc.signature_text }}</span>
                  <span v-else class="detail-value" style="color:#d97706">Pending</span>
                </div>
              </div>
            </div>
            <!-- Banking -->
            <div v-if="detail.banking?.bank_name" class="detail-section" style="border-bottom:none;margin-bottom:0">
              <div class="detail-section-title"><svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg> Banking Information</div>
              <div class="detail-grid">
                <div class="detail-item"><span class="detail-label">Bank Name</span><span class="detail-value">{{ detail.banking.bank_name }}</span></div>
                <div v-if="detail.banking.account_type" class="detail-item"><span class="detail-label">Account Type</span><span class="detail-value">{{ detail.banking.account_type }}</span></div>
                <div class="detail-item"><span class="detail-label">Routing Number</span><span class="detail-value">{{ detail.banking.routing_number }}</span></div>
                <div class="detail-item">
                  <span class="detail-label">Account Number</span>
                  <span class="detail-value" style="display:inline-flex;align-items:center;gap:0.4rem">
                    {{ showAcctNum ? detail.banking.account_number : '••••' + (detail.banking.account_number || '').slice(-4) }}
                    <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="cursor:pointer;color:#94a3b8;flex-shrink:0" @click="showAcctNum = !showAcctNum">
                      <path v-if="!showAcctNum" d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle v-if="!showAcctNum" cx="12" cy="12" r="3"/>
                      <path v-if="showAcctNum" d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line v-if="showAcctNum" x1="1" y1="1" x2="23" y2="23"/>
                    </svg>
                  </span>
                </div>
              </div>
            </div>
            <!-- No application linked -->
            <div v-if="!detail.application?.legal_name" style="text-align:center;padding:2rem;color:#94a3b8;font-size:13px">
              No application data linked to this investor.
            </div>

            <!-- Shared Documents -->
            <div v-if="selectedInvestorId" style="margin-top:1rem;border-top:1px solid #f1f5f9;padding-top:1rem">
              <LegalDocumentPortal :investor-id="selectedInvestorId" />
            </div>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script setup>
import { ref, reactive, computed } from 'vue'
import { useApi } from '../../composables/useApi'
import EmptyState from '../shared/EmptyState.vue'
import ConfirmModal from '../shared/ConfirmModal.vue'
import LegalDocumentPortal from '../investor/LegalDocumentPortal.vue'

const props = defineProps({
  investors: { type: Array, default: () => [] },
  carrierNames: { type: Array, default: () => [] },
})

const emit = defineEmits(['delete', 'update', 'picture-updated'])
const api = useApi()

const showConfirm = ref(false)
const pendingInv = ref(null)
const showEdit = ref(false)
const showDetail = ref(false)
const showAcctNum = ref(false)
const selectedInvestorId = ref(0)
const detailLoading = ref(false)
const detail = reactive({ application: null, vehicles: [], banking: {}, documents: [], profilePictureUrl: '', fullName: '' })
const picUploading = ref(false)

const modalInitials = computed(() => {
  const name = detail.application?.legal_name || detail.fullName || '?'
  return name
    .split(/\s+/)
    .map(w => w[0])
    .join('')
    .toUpperCase()
    .slice(0, 2)
})

async function viewDetail(inv) {
  selectedInvestorId.value = inv.id
  detail.profilePictureUrl = inv.profilePictureUrl || ''
  detail.fullName = inv.fullName || ''
  if (!inv.applicationId) {
    showDetail.value = true
    detailLoading.value = false
    detail.application = { legal_name: inv.fullName, entity_type: '', email: '' }
    detail.vehicles = []
    detail.banking = {}
    detail.documents = []
    return
  }
  showDetail.value = true
  detailLoading.value = true
  detail.application = null
  detail.vehicles = []
  detail.banking = {}
  detail.documents = []
  try {
    const data = await api.get(`/api/investor-applications/${inv.applicationId}`)
    detail.application = data.application
    detail.vehicles = data.vehicles || []
    detail.banking = data.banking || {}
    detail.documents = data.documents || []
  } catch { /* skip */ }
  finally { detailLoading.value = false }
}

async function onPicChange(event) {
  const file = event.target.files?.[0]
  if (!file || !selectedInvestorId.value) return
  picUploading.value = true
  try {
    const base64 = await resizeImageToBase64(file, 512)
    const res = await api.post(`/api/investors/${selectedInvestorId.value}/profile-picture`, {
      fileData: base64,
      fileName: file.name,
    })
    detail.profilePictureUrl = res.url
    emit('picture-updated')
  } catch (err) {
    /* silent */
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

function openPdf(url) { window.open(url, '_blank') }
const editForm = reactive({
  id: null, fullName: '', carrierName: '', status: 'Active', notes: '',
})

function openEdit(inv) {
  editForm.id = inv.id
  editForm.fullName = inv.fullName
  editForm.carrierName = inv.carrierName
  editForm.status = inv.status
  editForm.notes = inv.notes
  showEdit.value = true
}

function handleSaveEdit() {
  emit('update', { id: editForm.id, data: { ...editForm } })
  showEdit.value = false
}

function confirmDelete(inv) {
  pendingInv.value = inv
  showConfirm.value = true
}

function handleConfirmDelete() {
  if (pendingInv.value) emit('delete', pendingInv.value.id)
  showConfirm.value = false
  pendingInv.value = null
}
</script>

<style scoped>
.inv-avatar-wrap {
  position: relative;
  width: 56px;
  height: 56px;
  flex-shrink: 0;
  cursor: pointer;
  border-radius: 50%;
  overflow: hidden;
}
.inv-avatar-wrap .inv-avatar-overlay { opacity: 0; }
.inv-avatar-wrap:hover .inv-avatar-overlay,
.inv-avatar-wrap.inv-avatar-uploading .inv-avatar-overlay { opacity: 1; }
.inv-avatar-img {
  width: 56px;
  height: 56px;
  border-radius: 50%;
  object-fit: cover;
  display: block;
}
.inv-avatar-initials {
  width: 56px;
  height: 56px;
  border-radius: 50%;
  background: #e0f2fe;
  color: #0ea5e9;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 700;
  font-size: 1.1rem;
}
.inv-avatar-overlay {
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
.inv-avatar-input {
  position: absolute;
  inset: 0;
  opacity: 0;
  cursor: pointer;
  width: 100%;
  height: 100%;
}
.inv-spinner {
  width: 18px;
  height: 18px;
  border: 2px solid rgba(255, 255, 255, 0.35);
  border-top-color: #fff;
  border-radius: 50%;
  animation: inv-spin 0.7s linear infinite;
}
@keyframes inv-spin { to { transform: rotate(360deg); } }

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

.inv-table {
  width: 100%; border-collapse: separate; border-spacing: 0;
  font-size: 0.82rem; margin-top: 0.5rem;
}
.inv-table th {
  text-align: left; padding: 0.6rem 0.5rem; font-weight: 600;
  color: var(--text-dim); border-bottom: 2px solid var(--border);
  font-size: 0.68rem; text-transform: uppercase; letter-spacing: 0.06em;
}
.inv-table td {
  padding: 0.65rem 0.5rem; border-bottom: 1px solid var(--bg); vertical-align: middle;
}
.inv-table tbody tr { transition: background 0.1s; }
.inv-table tbody tr:hover { background: var(--bg); }
.inv-table tbody tr:last-child td { border-bottom: none; }

.name-cell { font-weight: 600; }
.mono { font-family: 'JetBrains Mono', monospace; }
.notes-cell { max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-dim); font-size: 0.78rem; }

.status-badge {
  display: inline-flex; align-items: center;
  padding: 0.2rem 0.6rem; border-radius: 12px;
  font-size: 0.68rem; font-weight: 600;
  font-family: 'JetBrains Mono', monospace; letter-spacing: 0.02em;
}
.status-active { background: var(--accent-dim); color: var(--accent); }
.status-inactive { background: var(--bg); color: var(--text-dim); }

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
  padding: 1.5rem; max-width: 500px; width: 90%;
  box-shadow: 0 8px 30px rgba(0,0,0,0.12);
  max-height: 90vh; overflow-y: auto;
}
.confirm-dialog h3 { font-size: 1rem; margin-bottom: 1rem; }
.confirm-actions {
  display: flex; justify-content: flex-end; gap: 0.5rem; margin-top: 1.25rem;
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
.edit-field input:focus,
.edit-field textarea:focus {
  outline: none; border-color: var(--blue);
}

.clickable-row { cursor: pointer; }
.detail-section { margin-bottom: 1.25rem; padding-bottom: 1rem; border-bottom: 1px solid #f1f5f9; }
.detail-section-title {
  display: flex; align-items: center; gap: 0.5rem;
  font-size: 0.82rem; font-weight: 700; color: #0f172a;
  text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 0.75rem;
}
.detail-section-title svg { color: #3b82f6; }
.detail-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0.5rem 1rem; }
.detail-item { display: flex; flex-direction: column; gap: 0.1rem; }
.detail-item.full { grid-column: 1 / -1; }
.detail-label { font-size: 0.7rem; font-weight: 600; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.04em; }
.detail-value { font-size: 0.85rem; color: #0f172a; font-weight: 500; }
</style>
