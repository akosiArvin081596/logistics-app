<template>
  <div class="flex flex-col">
    <div class="dash-header">
      <div>
        <h2 class="text-[1.4rem] font-bold text-gray-900 tracking-tight">Job Applications</h2>
        <p class="text-[13px] text-gray-400 mt-0.5">Review and manage employment applications</p>
      </div>
      <div class="flex items-center gap-3">
        <span class="text-[11px] text-gray-400 font-mono bg-gray-50 px-3 py-1.5 rounded-full border border-gray-100">{{ filteredApplications.length }} {{ activeFilter || 'total' }}</span>
        <button class="px-4 py-2 text-sm font-semibold bg-white text-gray-700 border border-gray-200 rounded-lg hover:border-gray-300 hover:shadow-sm transition-all duration-150" @click="load">&#8635; Refresh</button>
      </div>
    </div>

    <!-- KPI Cards -->
    <div class="kpi-grid" style="margin-bottom:1.25rem;">
      <Card v-for="card in kpiCards" :key="card.label" class="kpi-card" :class="[card.theme, { 'kpi-active': activeFilter === card.filter }]" style="cursor:pointer;" @click="handleKpiClick(card.filter)">
        <CardContent class="flex items-center gap-4" style="padding:1rem 1.25rem;">
          <div :class="['kpi-icon', card.iconTheme]" v-html="card.icon"></div>
          <div class="kpi-info">
            <div class="kpi-label">{{ card.label }}</div>
            <div class="kpi-value">{{ card.value }}</div>
            <div class="kpi-sub">{{ card.sub }}</div>
          </div>
        </CardContent>
      </Card>
    </div>

    <!-- Table -->
    <Card class="flex flex-col" style="border-radius:14px;border:1px solid #e8edf2;box-shadow:0 1px 4px rgba(0,0,0,0.06), 0 4px 12px rgba(0,0,0,0.04);">
      <CardContent style="padding:0;">
        <div v-if="loading" class="flex items-center justify-center py-16">
          <div class="text-[13px] text-gray-400">Loading applications...</div>
        </div>
        <div v-else-if="filteredApplications.length === 0" class="flex flex-col items-center justify-center py-16 gap-2">
          <div class="text-[2rem]">&#128203;</div>
          <div class="text-[14px] text-gray-500 font-medium">No applications yet</div>
          <div class="text-[12px] text-gray-400">Applications submitted at /apply will appear here</div>
        </div>
        <Table v-else>
          <TableHeader>
            <TableRow class="bg-gray-50/80 hover:bg-gray-50/80">
              <TableHead class="text-[11px] font-bold text-gray-500 uppercase tracking-wider">Name</TableHead>
              <TableHead class="text-[11px] font-bold text-gray-500 uppercase tracking-wider">Position</TableHead>
              <TableHead class="text-[11px] font-bold text-gray-500 uppercase tracking-wider">Email</TableHead>
              <TableHead class="text-[11px] font-bold text-gray-500 uppercase tracking-wider">Phone</TableHead>
              <TableHead class="text-[11px] font-bold text-gray-500 uppercase tracking-wider">CDL</TableHead>
              <TableHead class="text-[11px] font-bold text-gray-500 uppercase tracking-wider">Experience</TableHead>
              <TableHead class="text-[11px] font-bold text-gray-500 uppercase tracking-wider">Status</TableHead>
              <TableHead class="text-[11px] font-bold text-gray-500 uppercase tracking-wider">Applied</TableHead>
              <TableHead class="text-[11px] font-bold text-gray-500 uppercase tracking-wider text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow v-for="app in filteredApplications" :key="app.id" class="hover:bg-blue-50/30 transition-colors duration-100">
              <TableCell class="font-semibold text-[13px] text-gray-900">{{ app.full_name }}</TableCell>
              <TableCell><Badge :class="positionBadge(app.position)">{{ app.position }}</Badge></TableCell>
              <TableCell class="text-[13px] text-gray-600">{{ app.email }}</TableCell>
              <TableCell class="text-[13px] text-gray-600">{{ app.phone }}</TableCell>
              <TableCell class="text-[13px]">
                <span :class="app.has_cdl === 'Yes' ? 'text-emerald-600' : 'text-gray-400'">{{ app.has_cdl }}</span>
              </TableCell>
              <TableCell class="text-[13px] text-gray-600">{{ app.experience }}</TableCell>
              <TableCell>
                <Badge :class="statusBadge(app.status)">{{ app.status }}</Badge>
              </TableCell>
              <TableCell class="text-[13px] text-gray-500">{{ formatDate(app.created_at) }}</TableCell>
              <TableCell class="text-right">
                <div class="flex items-center justify-end gap-1.5">
                  <Button size="sm" variant="outline" class="rounded-md border-[#e2e4ea] text-[12px] h-8" @click="openDetail(app)">View</Button>
                  <a :href="'/api/applications/' + app.id + '/pdf'" target="_blank"><Button size="sm" variant="outline" class="rounded-md border-[#e2e4ea] text-[12px] h-8">PDF</Button></a>
                  <Button v-if="app.status === 'Accepted' && app.onboarding_user_id && app.drug_test_result !== 'pass'" size="sm" variant="outline" class="rounded-md border-[#e2e4ea] text-[12px] h-8 text-amber-600 border-amber-200 hover:bg-amber-50" @click="openDrugTest(app)">Drug Test</Button>
                  <select class="text-[12px] border border-[#e2e4ea] rounded-md px-2 py-1 bg-white" :value="app.status" @change="updateStatus(app.id, $event.target.value)">
                    <option v-for="s in statuses" :key="s" :value="s">{{ s }}</option>
                  </select>
                  <button
                    type="button"
                    class="delete-icon-btn"
                    aria-label="Remove applicant from list"
                    title="Remove from list"
                    @click="confirmDelete(app)"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <polyline points="3 6 5 6 21 6"></polyline>
                      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path>
                      <path d="M10 11v6M14 11v6"></path>
                      <path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"></path>
                    </svg>
                  </button>
                </div>
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </CardContent>
    </Card>

    <!-- Soft-delete Confirmation Dialog -->
    <Dialog v-model:open="showDeleteConfirm">
      <DialogContent class="sm:max-w-[420px] rounded-[14px] border-[#e8edf2] shadow-[0_8px_32px_rgba(0,0,0,0.12)] p-0 gap-0 overflow-hidden">
        <DialogHeader class="px-6 pt-5 pb-4 border-b border-[#e8edf2] bg-gradient-to-b from-red-50/70 to-white">
          <DialogTitle class="text-[1.1rem] font-bold text-gray-900">Remove applicant?</DialogTitle>
          <DialogDescription class="text-[13px] text-gray-500">
            Are you sure? This will hide the applicant from the list. The record stays in the database and can be restored later.
          </DialogDescription>
        </DialogHeader>
        <div v-if="deleteTarget" class="px-6 py-4">
          <div class="flex items-center justify-between py-2 px-3 bg-gray-50 rounded-lg">
            <span class="text-[12px] text-gray-500 font-medium">Applicant</span>
            <span class="text-[14px] font-semibold text-gray-900">{{ deleteTarget.full_name }}</span>
          </div>
        </div>
        <div class="flex items-center justify-end gap-2 px-6 py-4 border-t border-[#e8edf2] bg-gray-50/40">
          <Button variant="outline" class="rounded-md text-[13px] h-9" :disabled="deleting" @click="cancelDelete">Cancel</Button>
          <Button class="rounded-md text-[13px] h-9 bg-red-600 hover:bg-red-700 text-white" :disabled="deleting" @click="performDelete">
            {{ deleting ? 'Removing...' : 'Remove from list' }}
          </Button>
        </div>
      </DialogContent>
    </Dialog>

    <!-- Credentials Dialog (shown after accepting an application) -->
    <Dialog v-model:open="showCredentials">
      <DialogContent class="sm:max-w-[420px] rounded-[14px] border-[#e8edf2] shadow-[0_8px_32px_rgba(0,0,0,0.12)] p-0 gap-0 overflow-hidden">
        <DialogHeader class="px-6 pt-5 pb-4 border-b border-[#e8edf2] bg-gradient-to-b from-emerald-50/80 to-white">
          <DialogTitle class="text-[1.1rem] font-bold text-gray-900">Driver Account Created</DialogTitle>
          <DialogDescription class="text-[13px] text-gray-500">Share these credentials with the driver so they can log in and complete onboarding.</DialogDescription>
        </DialogHeader>
        <div v-if="createdCredentials" class="px-6 py-5">
          <div class="space-y-3">
            <div class="flex justify-between items-center py-2 px-3 bg-gray-50 rounded-lg">
              <span class="text-[12px] text-gray-500 font-medium">Driver</span>
              <span class="text-[14px] font-bold text-gray-900">{{ createdCredentials.driverName }}</span>
            </div>
            <div class="flex justify-between items-center py-2 px-3 bg-gray-50 rounded-lg">
              <span class="text-[12px] text-gray-500 font-medium">Username</span>
              <span class="text-[14px] font-mono font-bold text-blue-700">{{ createdCredentials.username }}</span>
            </div>
            <div class="flex justify-between items-center py-2 px-3 bg-amber-50 rounded-lg border border-amber-100">
              <span class="text-[12px] text-gray-500 font-medium">Temp Password</span>
              <span class="text-[14px] font-mono font-bold text-amber-700">{{ createdCredentials.tempPassword }}</span>
            </div>
          </div>
          <p class="text-[11px] text-gray-400 mt-4 text-center">The driver can now log in to sign onboarding documents.</p>
        </div>
      </DialogContent>
    </Dialog>

    <!-- Detail Modal -->
    <Dialog v-model:open="showDetail">
      <DialogContent class="sm:max-w-[600px] rounded-[14px] border-[#e8edf2] shadow-[0_8px_32px_rgba(0,0,0,0.12)] p-0 gap-0 overflow-hidden max-h-[85vh]">
        <DialogHeader class="px-6 pt-5 pb-4 border-b border-[#e8edf2] bg-gradient-to-b from-gray-50/80 to-white">
          <DialogTitle class="text-[1.1rem] font-bold text-gray-900">{{ selectedApp?.full_name }}</DialogTitle>
          <DialogDescription class="text-[13px] text-gray-400">Applied for {{ selectedApp?.position }} on {{ formatDate(selectedApp?.created_at) }}</DialogDescription>
        </DialogHeader>
        <div v-if="selectedApp" class="px-6 py-5 overflow-y-auto" style="max-height:60vh;">
          <div class="detail-grid">
            <div class="detail-section">
              <h4>Personal Information</h4>
              <div class="detail-row"><span>Email:</span><span>{{ selectedApp.email }}</span></div>
              <div class="detail-row"><span>Phone:</span><span>{{ selectedApp.phone }}</span></div>
              <div v-if="selectedApp.cell" class="detail-row"><span>Cell:</span><span>{{ selectedApp.cell }}</span></div>
              <div class="detail-row"><span>DOB:</span><span>{{ selectedApp.dob }}</span></div>
              <div class="detail-row"><span>Address:</span><span>{{ selectedApp.address }}</span></div>
              <div v-if="selectedApp.city || selectedApp.state || selectedApp.zip" class="detail-row"><span>City/State/ZIP:</span><span>{{ [selectedApp.city, selectedApp.state].filter(Boolean).join(', ') }}{{ selectedApp.zip ? ' ' + selectedApp.zip : '' }}</span></div>
              <div class="detail-row"><span>SSN:</span><span>{{ maskSSN(selectedApp.ssn) }}</span></div>
              <div class="detail-row"><span>License:</span><span>{{ selectedApp.drivers_license }}</span></div>
              <div v-if="selectedApp.dot" class="detail-row"><span>DOT #:</span><span>{{ selectedApp.dot }}</span></div>
              <div v-if="selectedApp.mc" class="detail-row"><span>MC #:</span><span>{{ selectedApp.mc }}</span></div>
              <div class="detail-row"><span>Hazmat:</span><span>{{ selectedApp.hazmat || 'No' }}</span></div>
            </div>
            <div class="detail-section">
              <h4>Experience &amp; Qualifications</h4>
              <div class="detail-row"><span>Experience:</span><span>{{ selectedApp.experience }}</span></div>
              <div class="detail-row"><span>CDL:</span><span>{{ selectedApp.has_cdl }}</span></div>
              <div class="detail-row"><span>Work Authorized:</span><span>{{ selectedApp.work_authorized }}</span></div>
              <div class="detail-row"><span>Felony:</span><span>{{ selectedApp.felony_convicted }}</span></div>
              <div v-if="selectedApp.felony_explanation" class="detail-row"><span>Explanation:</span><span>{{ selectedApp.felony_explanation }}</span></div>
            </div>
            <div class="detail-section">
              <h4>Driving History</h4>
              <div class="detail-row"><span>Accident History:</span><span>{{ selectedApp.accident_history }}</span></div>
              <div v-if="selectedApp.accident_description" class="detail-row"><span>Description:</span><span>{{ selectedApp.accident_description }}</span></div>
              <div class="detail-row"><span>Traffic Citations:</span><span>{{ selectedApp.traffic_citations || 'N/A' }}</span></div>
            </div>
            <div class="detail-section">
              <h4>Certifications &amp; Availability</h4>
              <div v-if="selectedApp.certifications" class="detail-row"><span>Certifications:</span><span>{{ selectedApp.certifications }}</span></div>
              <div class="detail-row"><span>Availability:</span><span>{{ parseAvailability(selectedApp.availability) }}</span></div>
              <div class="detail-row"><span>Skills:</span><span>{{ selectedApp.skills }}</span></div>
            </div>
            <div class="detail-section">
              <h4>References</h4>
              <template v-if="parsedReferences.length">
                <div v-for="(ref, i) in parsedReferences" :key="i" class="detail-row"><span>Reference {{ i + 1 }}:</span><span>Company: {{ ref.name || '—' }} | Phone: {{ ref.phone || '—' }} | Email: {{ ref.relationship || '—' }}{{ ref.contactPerson ? ' | Contact: ' + ref.contactPerson : '' }}</span></div>
              </template>
              <div v-else-if="selectedApp.reference_info" class="detail-row"><span>Reference:</span><span>{{ selectedApp.reference_info }}</span></div>
              <div v-if="selectedApp.additional_info" class="detail-row"><span>Additional:</span><span>{{ selectedApp.additional_info }}</span></div>
              <div class="detail-row"><span>Signature:</span><span class="font-italic">{{ selectedApp.signature }}</span></div>
              <div class="detail-row"><span>Date:</span><span>{{ selectedApp.signature_date }}</span></div>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>

    <DrugTestUpload
      :show="showDrugTest"
      :user-id="drugTestApp?.onboarding_user_id || 0"
      :driver-name="drugTestApp?.full_name || ''"
      @close="showDrugTest = false"
      @uploaded="showDrugTest = false; load()"
    />
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { useApi } from '../composables/useApi'
import { useToast } from '../composables/useToast'
import { useSocketRefresh } from '../composables/useSocketRefresh'
import { Card, CardContent } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import DrugTestUpload from '../components/users/DrugTestUpload.vue'

const api = useApi()
const { show: toast } = useToast()
useSocketRefresh('applications:changed', () => load())
const applications = ref([])
const loading = ref(false)
const showDrugTest = ref(false)
const drugTestApp = ref(null)

function openDrugTest(app) {
  drugTestApp.value = app
  showDrugTest.value = true
}
const showDetail = ref(false)
const selectedApp = ref(null)
const activeFilter = ref(null)
const statuses = ['New', 'Reviewed', 'Accepted', 'Rejected']

const filteredApplications = computed(() => {
  if (!activeFilter.value) return applications.value
  return applications.value.filter(a => a.status === activeFilter.value)
})

const parsedReferences = computed(() => {
  if (!selectedApp.value?.reference_info) return []
  try {
    const refs = JSON.parse(selectedApp.value.reference_info)
    return Array.isArray(refs) ? refs : []
  } catch { return [] }
})

const kpiCards = computed(() => {
  const a = applications.value
  return [
    { label: 'Total', value: a.length, sub: 'Applications', icon: '&#128203;', theme: 'kpi-blue', iconTheme: 'kpi-icon-blue', filter: null },
    { label: 'New', value: a.filter(x => x.status === 'New').length, sub: 'Pending review', icon: '&#10071;', theme: 'kpi-amber', iconTheme: 'kpi-icon-amber', filter: 'New' },
    { label: 'Accepted', value: a.filter(x => x.status === 'Accepted').length, sub: 'Approved', icon: '&#10003;', theme: 'kpi-emerald', iconTheme: 'kpi-icon-emerald', filter: 'Accepted' },
    { label: 'Rejected', value: a.filter(x => x.status === 'Rejected').length, sub: 'Declined', icon: '&#10007;', theme: 'kpi-violet', iconTheme: 'kpi-icon-violet', filter: 'Rejected' },
  ]
})

function handleKpiClick(filter) {
  activeFilter.value = activeFilter.value === filter ? null : filter
}

async function load() {
  loading.value = true
  try {
    applications.value = await api.get('/api/applications')
  } catch (err) {
    toast(err.message, 'error')
  } finally {
    loading.value = false
  }
}

const showCredentials = ref(false)
const createdCredentials = ref(null)
const showDeleteConfirm = ref(false)
const deleteTarget = ref(null)
const deleting = ref(false)

async function updateStatus(id, status) {
  try {
    const result = await api.put(`/api/applications/${id}/status`, { status })
    if (result.accountCreated && result.credentials) {
      createdCredentials.value = result.credentials
      showCredentials.value = true
      toast('Application accepted — driver account created', 'success')
    } else {
      toast(`Status updated to ${status}`, 'success')
    }
    const row = applications.value.find(a => a.id === id)
    if (row) row.status = status
  } catch (err) {
    toast(err.message, 'error')
  }
}

async function openDetail(app) {
  selectedApp.value = app
  showDetail.value = true
  try {
    const full = await api.get(`/api/applications/${app.id}`)
    if (selectedApp.value && selectedApp.value.id === app.id) {
      selectedApp.value = full
    }
  } catch (err) {
    toast(err.message, 'error')
  }
}

function confirmDelete(app) {
  deleteTarget.value = app
  showDeleteConfirm.value = true
}

function cancelDelete() {
  showDeleteConfirm.value = false
  deleteTarget.value = null
}

async function performDelete() {
  if (!deleteTarget.value) return
  const id = deleteTarget.value.id
  deleting.value = true
  try {
    await api.del(`/api/applications/${id}`)
    applications.value = applications.value.filter(a => a.id !== id)
    toast('Applicant removed from list', 'success')
    showDeleteConfirm.value = false
    deleteTarget.value = null
  } catch (err) {
    toast(err.message, 'error')
  } finally {
    deleting.value = false
  }
}

function formatDate(d) {
  if (!d) return ''
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function maskSSN(ssn) {
  if (!ssn || ssn.length < 4) return '***-**-****'
  return '***-**-' + ssn.slice(-4)
}

function parseAvailability(val) {
  try { return JSON.parse(val).join(', ') } catch { return val || 'N/A' }
}

function statusBadge(status) {
  if (status === 'New') return 'bg-blue-50 text-blue-700 border border-blue-200 text-[11px] font-semibold'
  if (status === 'Reviewed') return 'bg-amber-50 text-amber-700 border border-amber-200 text-[11px] font-semibold'
  if (status === 'Accepted') return 'bg-emerald-50 text-emerald-700 border border-emerald-200 text-[11px] font-semibold'
  return 'bg-red-50 text-red-700 border border-red-200 text-[11px] font-semibold'
}

function positionBadge(pos) {
  if (pos === 'Company Driver') return 'bg-cyan-50 text-cyan-700 border border-cyan-200 text-[11px] font-semibold'
  if (pos === 'Owner Operator') return 'bg-purple-50 text-purple-700 border border-purple-200 text-[11px] font-semibold'
  return 'bg-gray-50 text-gray-600 border border-gray-200 text-[11px] font-semibold'
}

onMounted(load)
</script>

<style scoped>
.delete-icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  margin-left: 2px;
  border-radius: 6px;
  border: 1px solid transparent;
  background: transparent;
  color: #94a3b8;
  cursor: pointer;
  transition: color 0.15s ease, background 0.15s ease, border-color 0.15s ease;
}
.delete-icon-btn:hover {
  color: #dc2626;
  background: #fef2f2;
  border-color: #fecaca;
}
.delete-icon-btn:focus-visible {
  outline: 2px solid #dc2626;
  outline-offset: 2px;
}

.detail-grid {
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
}
.detail-section h4 {
  font-size: 0.82rem;
  font-weight: 700;
  color: hsl(199, 89%, 48%);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  margin-bottom: 0.6rem;
  padding-bottom: 0.4rem;
  border-bottom: 1px solid #e8edf2;
}
.detail-row {
  display: flex;
  gap: 0.5rem;
  font-size: 0.85rem;
  padding: 0.3rem 0;
}
.detail-row span:first-child {
  font-weight: 600;
  color: #6b7280;
  min-width: 120px;
  flex-shrink: 0;
}
.detail-row span:last-child {
  color: #111827;
}
.font-italic { font-style: italic; }
:deep(.kpi-active) {
  border: 2px solid hsl(199, 89%, 48%) !important;
  box-shadow: 0 0 0 3px rgba(56, 189, 248, 0.12) !important;
}
</style>
