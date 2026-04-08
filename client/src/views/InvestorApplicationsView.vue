<template>
  <div class="admin-page">
    <div class="dash-header">
      <div>
        <h2 class="text-[1.4rem] font-bold text-gray-900 tracking-tight">Investor Applications</h2>
        <p class="text-[13px] text-gray-400 mt-0.5">Review and manage investor onboarding applications</p>
      </div>
      <div class="flex items-center gap-3">
        <span class="text-[11px] text-gray-400 font-mono bg-gray-50 px-3 py-1.5 rounded-full border border-gray-100">{{ applications.length }} total</span>
        <button class="px-4 py-2 text-sm font-semibold bg-white text-gray-700 border border-gray-200 rounded-lg hover:border-gray-300 hover:shadow-sm transition-all" @click="load">&#8635; Refresh</button>
      </div>
    </div>

    <!-- Outreach Email Section -->
    <details class="form-accordion" style="margin-bottom:1rem;">
      <summary class="form-toggle">+ Send Investor Invite</summary>
      <div style="padding:1rem;">
        <div style="margin-bottom:0.75rem;">
          <label class="text-[12px] font-semibold text-gray-600 block mb-1">Email Addresses (comma-separated)</label>
          <textarea v-model="outreach.emailsRaw" rows="2" class="w-full px-3 py-2 text-[13px] border border-gray-200 rounded-lg" placeholder="investor1@email.com, investor2@email.com"></textarea>
        </div>
        <div style="margin-bottom:0.75rem;">
          <label class="text-[12px] font-semibold text-gray-600 block mb-1">Subject</label>
          <input v-model="outreach.subject" class="w-full px-3 py-2 text-[13px] border border-gray-200 rounded-lg" />
        </div>
        <div style="margin-bottom:0.75rem;">
          <label class="text-[12px] font-semibold text-gray-600 block mb-1">Message</label>
          <textarea v-model="outreach.body" rows="12" class="w-full px-3 py-2 text-[13px] border border-gray-200 rounded-lg font-mono" style="line-height:1.5;"></textarea>
        </div>
        <div class="flex items-center justify-between">
          <span v-if="outreach.result" class="text-[12px]" :class="outreach.result.failures?.length ? 'text-amber-600' : 'text-emerald-600'">
            Sent {{ outreach.result.sentCount }}/{{ outreach.result.total }} emails
          </span>
          <span v-else></span>
          <button class="px-5 py-2 text-sm font-bold bg-blue-500 text-white rounded-lg hover:bg-blue-600 transition-all" :disabled="outreach.sending || !outreach.emailsRaw.trim()" @click="sendOutreach">
            {{ outreach.sending ? 'Sending...' : 'Send Invites' }}
          </button>
        </div>
        <!-- Recent sends -->
        <div v-if="outreachLog.length" style="margin-top:1rem;border-top:1px solid #e8edf2;padding-top:0.75rem;">
          <div class="text-[11px] font-bold text-gray-400 uppercase mb-2">Recent Sends</div>
          <div v-for="log in outreachLog" :key="log.id" class="flex items-center justify-between py-1 text-[12px]">
            <span class="text-gray-700">{{ log.email }}</span>
            <span class="flex items-center gap-2">
              <span :class="log.status === 'sent' ? 'text-emerald-600' : 'text-red-500'">{{ log.status }}</span>
              <span class="text-gray-400">{{ formatDate(log.created_at) }}</span>
            </span>
          </div>
        </div>
      </div>
    </details>

    <Card class="flex flex-col" style="border-radius:14px;border:1px solid #e8edf2;box-shadow:0 1px 4px rgba(0,0,0,0.06);">
      <CardContent style="padding:0;">
        <div v-if="loading" class="flex items-center justify-center py-16">
          <div class="text-[13px] text-gray-400">Loading...</div>
        </div>
        <div v-else-if="applications.length === 0" class="flex flex-col items-center justify-center py-16 gap-2">
          <div class="text-[2rem]">&#128188;</div>
          <div class="text-[14px] text-gray-500 font-medium">No investor applications yet</div>
          <div class="text-[12px] text-gray-400">Share the /invest link with potential investors</div>
        </div>
        <Table v-else>
          <TableHeader>
            <TableRow class="bg-gray-50/80 hover:bg-gray-50/80">
              <TableHead class="text-[11px] font-bold text-gray-500 uppercase tracking-wider">Name</TableHead>
              <TableHead class="text-[11px] font-bold text-gray-500 uppercase tracking-wider">Entity</TableHead>
              <TableHead class="text-[11px] font-bold text-gray-500 uppercase tracking-wider">Email</TableHead>
              <TableHead class="text-[11px] font-bold text-gray-500 uppercase tracking-wider">Phone</TableHead>
              <TableHead class="text-[11px] font-bold text-gray-500 uppercase tracking-wider">Docs</TableHead>
              <TableHead class="text-[11px] font-bold text-gray-500 uppercase tracking-wider">Onboarding</TableHead>
              <TableHead class="text-[11px] font-bold text-gray-500 uppercase tracking-wider">Status</TableHead>
              <TableHead class="text-[11px] font-bold text-gray-500 uppercase tracking-wider text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow v-for="app in applications" :key="app.id" class="hover:bg-blue-50/30 transition-colors cursor-pointer" @click="viewDetail(app)">
              <TableCell class="font-semibold text-[13px] text-gray-900">{{ app.legal_name }}</TableCell>
              <TableCell class="text-[13px] text-gray-600">{{ app.entity_type || '-' }}</TableCell>
              <TableCell class="text-[13px] text-gray-600">{{ app.email }}</TableCell>
              <TableCell class="text-[13px] text-gray-600">{{ app.phone }}</TableCell>
              <TableCell class="text-[13px]">{{ app.signed_count || 0 }}/3</TableCell>
              <TableCell><Badge :class="obBadge(app.onboarding_status)">{{ app.onboarding_status || 'pending' }}</Badge></TableCell>
              <TableCell><Badge :class="statusBadge(app.status)">{{ app.status }}</Badge></TableCell>
              <TableCell class="text-right" @click.stop>
                <div class="flex items-center justify-end gap-1.5">
                  <Button size="sm" variant="outline" class="rounded-md border-[#e2e4ea] text-[12px] h-8" @click="viewDetail(app)">View</Button>
                  <select class="text-[12px] border border-[#e2e4ea] rounded-md px-2 py-1 bg-white" :value="app.status" @change="updateStatus(app.id, $event.target.value)">
                    <option v-for="s in statuses" :key="s" :value="s">{{ s }}</option>
                  </select>
                </div>
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </CardContent>
    </Card>

    <!-- Credentials Dialog -->
    <Dialog v-model:open="showCredentials">
      <DialogContent class="sm:max-w-[420px] rounded-[14px] border-[#e8edf2] shadow-[0_8px_32px_rgba(0,0,0,0.12)] p-0 gap-0 overflow-hidden">
        <DialogHeader class="px-6 pt-5 pb-4 border-b border-[#e8edf2] bg-gradient-to-b from-emerald-50/80 to-white">
          <DialogTitle class="text-[1.1rem] font-bold text-gray-900">Investor Account Created</DialogTitle>
          <DialogDescription class="text-[13px] text-gray-500">Share these credentials with the investor.</DialogDescription>
        </DialogHeader>
        <div v-if="credentials" class="px-6 py-5 space-y-3">
          <div class="flex justify-between items-center py-2 px-3 bg-gray-50 rounded-lg">
            <span class="text-[12px] text-gray-500">Investor</span>
            <span class="text-[14px] font-bold text-gray-900">{{ credentials.investorName }}</span>
          </div>
          <div class="flex justify-between items-center py-2 px-3 bg-gray-50 rounded-lg">
            <span class="text-[12px] text-gray-500">Username</span>
            <span class="text-[14px] font-mono font-bold text-blue-700">{{ credentials.username }}</span>
          </div>
          <div class="flex justify-between items-center py-2 px-3 bg-amber-50 rounded-lg border border-amber-100">
            <span class="text-[12px] text-gray-500">Temp Password</span>
            <span class="text-[14px] font-mono font-bold text-amber-700">{{ credentials.tempPassword }}</span>
          </div>
        </div>
      </DialogContent>
    </Dialog>

    <!-- Detail Dialog -->
    <Dialog v-model:open="showDetail">
      <DialogContent class="sm:max-w-[680px] rounded-[14px] border-[#e8edf2] shadow-[0_8px_32px_rgba(0,0,0,0.12)] p-0 gap-0 overflow-hidden max-h-[90vh]">
        <DialogHeader class="px-6 pt-5 pb-4 border-b border-[#e8edf2]">
          <DialogTitle class="text-[1.1rem] font-bold text-gray-900">{{ detail.application?.legal_name || 'Application' }}</DialogTitle>
          <DialogDescription class="text-[13px] text-gray-400">{{ detail.application?.entity_type }} | {{ detail.application?.email }}</DialogDescription>
        </DialogHeader>
        <div v-if="detailLoading" class="flex items-center justify-center py-16">
          <div class="text-[13px] text-gray-400">Loading...</div>
        </div>
        <div v-else-if="detail.application" class="px-6 py-5 overflow-y-auto space-y-5" style="max-height:68vh;">
          <!-- Application Info -->
          <div>
            <div class="detail-section-title">
              <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
              Application Details
            </div>
            <div class="detail-grid">
              <div class="detail-item"><span class="detail-label">Legal Name</span><span class="detail-value">{{ detail.application.legal_name }}</span></div>
              <div v-if="detail.application.dba" class="detail-item"><span class="detail-label">DBA</span><span class="detail-value">{{ detail.application.dba }}</span></div>
              <div v-if="detail.application.entity_type" class="detail-item"><span class="detail-label">Entity Type</span><span class="detail-value">{{ detail.application.entity_type }}</span></div>
              <div class="detail-item col-span-2"><span class="detail-label">Address</span><span class="detail-value">{{ detail.application.address }}</span></div>
              <div v-if="detail.application.contact_person" class="detail-item"><span class="detail-label">Contact Person</span><span class="detail-value">{{ detail.application.contact_person }}</span></div>
              <div v-if="detail.application.contact_title" class="detail-item"><span class="detail-label">Title</span><span class="detail-value">{{ detail.application.contact_title }}</span></div>
              <div class="detail-item"><span class="detail-label">Phone</span><span class="detail-value">{{ detail.application.phone }}</span></div>
              <div class="detail-item"><span class="detail-label">Email</span><span class="detail-value">{{ detail.application.email }}</span></div>
              <div v-if="detail.application.ein_ssn" class="detail-item"><span class="detail-label">EIN/SSN</span><span class="detail-value">{{ detail.application.ein_ssn }}</span></div>
              <div v-if="detail.application.tax_classification" class="detail-item"><span class="detail-label">Tax Classification</span><span class="detail-value">{{ detail.application.tax_classification }}</span></div>
              <div v-if="detail.application.years_in_operation" class="detail-item"><span class="detail-label">Years in Operation</span><span class="detail-value">{{ detail.application.years_in_operation }}</span></div>
              <div v-if="detail.application.industry_experience" class="detail-item"><span class="detail-label">Industry Experience</span><span class="detail-value">{{ detail.application.industry_experience }}</span></div>
              <div v-if="detail.application.bankruptcy_liens" class="detail-item col-span-2"><span class="detail-label">Bankruptcy/Liens</span><span class="detail-value">{{ detail.application.bankruptcy_liens }}</span></div>
            </div>
          </div>

          <!-- Fleet -->
          <div v-if="detail.vehicles.length">
            <div class="detail-section-title">
              <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="3" width="15" height="13"/><polygon points="16 8 20 8 23 11 23 16 16 16 16 8"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/></svg>
              Fleet ({{ detail.vehicles.length }} vehicle{{ detail.vehicles.length > 1 ? 's' : '' }})
            </div>
            <div v-for="(v, i) in detail.vehicles" :key="i" class="mb-2 p-3 bg-[#fafbfd] rounded-lg border border-[#f1f5f9]">
              <div class="text-[11px] font-bold text-gray-400 uppercase mb-2">Vehicle {{ String.fromCharCode(65 + i) }}</div>
              <div class="detail-grid">
                <div class="detail-item"><span class="detail-label">Make</span><span class="detail-value">{{ v.make }}</span></div>
                <div class="detail-item"><span class="detail-label">Model</span><span class="detail-value">{{ v.model }}</span></div>
                <div class="detail-item"><span class="detail-label">Year</span><span class="detail-value">{{ v.year }}</span></div>
                <div class="detail-item"><span class="detail-label">VIN</span><span class="detail-value">{{ v.vin }}</span></div>
                <div v-if="v.licensePlate" class="detail-item"><span class="detail-label">License Plate</span><span class="detail-value">{{ v.licensePlate }}</span></div>
                <div v-if="v.titleState" class="detail-item"><span class="detail-label">Title State</span><span class="detail-value">{{ v.titleState }}</span></div>
                <div v-if="v.registeredOwner" class="detail-item"><span class="detail-label">Registered Owner</span><span class="detail-value">{{ v.registeredOwner }}</span></div>
                <div v-if="v.purchasePrice" class="detail-item"><span class="detail-label">Purchase Price</span><span class="detail-value">${{ Number(v.purchasePrice).toLocaleString() }}</span></div>
              </div>
            </div>
          </div>

          <!-- Documents -->
          <div v-if="detail.documents.length">
            <div class="detail-section-title">
              <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
              Documents ({{ detail.documents.filter(d => d.signed).length }}/{{ detail.documents.length }} signed)
            </div>
            <div class="detail-grid">
              <div v-for="doc in detail.documents" :key="doc.doc_key" class="detail-item col-span-2">
                <span class="detail-label">{{ doc.doc_name }}</span>
                <span v-if="doc.signed && doc.signed_pdf_url" class="detail-value text-emerald-600 cursor-pointer hover:underline inline-flex items-center gap-1" @click="window.open(doc.signed_pdf_url, '_blank')">
                  Signed by {{ doc.signature_text }} &mdash; View PDF
                  <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                </span>
                <span v-else-if="doc.signed" class="detail-value text-emerald-600">Signed by {{ doc.signature_text }}</span>
                <span v-else class="detail-value text-amber-600">Pending</span>
              </div>
            </div>
          </div>

          <!-- Banking -->
          <div v-if="detail.banking?.bank_name">
            <div class="detail-section-title">
              <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
              Banking Information
            </div>
            <div class="detail-grid">
              <div class="detail-item"><span class="detail-label">Bank Name</span><span class="detail-value">{{ detail.banking.bank_name }}</span></div>
              <div v-if="detail.banking.account_type" class="detail-item"><span class="detail-label">Account Type</span><span class="detail-value">{{ detail.banking.account_type }}</span></div>
              <div v-if="detail.banking.account_name" class="detail-item"><span class="detail-label">Name on Account</span><span class="detail-value">{{ detail.banking.account_name }}</span></div>
              <div class="detail-item"><span class="detail-label">Routing Number</span><span class="detail-value">{{ detail.banking.routing_number }}</span></div>
              <div class="detail-item"><span class="detail-label">Account Number</span><span class="detail-value">{{ '••••' + (detail.banking.account_number || '').slice(-4) }}</span></div>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue'
import { useApi } from '../composables/useApi'
import { useToast } from '../composables/useToast'
import { Card, CardContent } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'

const api = useApi()
const { show: toast } = useToast()
const applications = ref([])
const loading = ref(false)
const showCredentials = ref(false)
const credentials = ref(null)
const showDetail = ref(false)
const detailLoading = ref(false)
const detail = reactive({ application: null, vehicles: [], banking: {}, documents: [] })
const statuses = ['New', 'Reviewed', 'Accepted', 'Rejected']

function statusBadge(s) {
  if (s === 'Accepted') return 'bg-emerald-50 text-emerald-700 border-emerald-200'
  if (s === 'Rejected') return 'bg-red-50 text-red-700 border-red-200'
  if (s === 'Reviewed') return 'bg-blue-50 text-blue-700 border-blue-200'
  return 'bg-gray-50 text-gray-600 border-gray-200'
}

function obBadge(s) {
  if (s === 'fully_onboarded') return 'bg-emerald-50 text-emerald-700 border-emerald-200'
  if (s === 'banking_pending') return 'bg-amber-50 text-amber-700 border-amber-200'
  return 'bg-gray-50 text-gray-600 border-gray-200'
}

async function load() {
  loading.value = true
  try {
    applications.value = await api.get('/api/investor-applications')
  } catch (err) {
    toast(err.message, 'error')
  } finally {
    loading.value = false
  }
}

async function updateStatus(id, status) {
  try {
    const result = await api.put(`/api/investor-applications/${id}/status`, { status })
    if (result.accountCreated && result.credentials) {
      credentials.value = result.credentials
      showCredentials.value = true
      toast('Investor accepted — account created', 'success')
    } else {
      toast(`Status updated to ${status}`, 'success')
    }
    await load()
  } catch (err) {
    toast(err.message, 'error')
  }
}

async function viewDetail(app) {
  showDetail.value = true
  detailLoading.value = true
  detail.application = null
  detail.vehicles = []
  detail.banking = {}
  detail.documents = []
  try {
    const data = await api.get(`/api/investor-applications/${app.id}`)
    detail.application = data.application
    detail.vehicles = data.vehicles || []
    detail.banking = data.banking || {}
    detail.documents = data.documents || []
  } catch (err) {
    toast(err.message, 'error')
  } finally {
    detailLoading.value = false
  }
}

// Outreach
const investUrl = `${window.location.origin}/invest`
const outreach = reactive({
  emailsRaw: '',
  subject: 'LogisX Investor Onboarding Invitation',
  body: `Dear Investor,

You are invited to join LogisX Inc. as a fleet participant.

To begin the onboarding process, please visit the link below and complete the 3-step wizard:

${investUrl}

Step 1: Complete your application
Step 2: Review and sign the Master Participation Agreement and Vehicle Lease
Step 3: Submit your W-9 and banking information

If you have questions, contact us at info@logisx.com or call our office.

Best regards,
Deshorn King, CEO
LogisX Inc.
4576 Research Forest Dr, Suite 200
The Woodlands, TX 77381
USDOT# 4302683`,
  sending: false,
  result: null,
})
const outreachLog = ref([])

async function sendOutreach() {
  if (outreach.sending) return
  outreach.sending = true
  outreach.result = null
  try {
    const emails = outreach.emailsRaw.split(',').map(e => e.trim()).filter(Boolean)
    if (emails.length === 0) { toast('Enter at least one email', 'error'); return }
    const result = await api.post('/api/investor-outreach/send', {
      emails,
      subject: outreach.subject,
      body: outreach.body,
    })
    outreach.result = result
    if (result.sentCount > 0) toast(`${result.sentCount} invite(s) sent`, 'success')
    if (result.failures?.length) toast(`${result.failures.length} failed`, 'error')
    outreach.emailsRaw = ''
    await loadOutreachLog()
  } catch (err) {
    toast(err.message || 'Send failed', 'error')
  } finally {
    outreach.sending = false
  }
}

async function loadOutreachLog() {
  try {
    const data = await api.get('/api/investor-outreach/log')
    outreachLog.value = data.logs || []
  } catch { /* ignore */ }
}

function formatDate(d) {
  if (!d) return ''
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

onMounted(() => { load(); loadOutreachLog() })
</script>

<style scoped>
.detail-section-title {
  display: flex; align-items: center; gap: 0.4rem;
  font-size: 0.82rem; font-weight: 700; color: #0f172a;
  margin-bottom: 0.6rem; padding-bottom: 0.4rem;
  border-bottom: 1px solid #e8edf2;
}
.detail-section-title svg { color: #3b82f6; }
.detail-grid {
  display: grid; grid-template-columns: 1fr 1fr; gap: 0.35rem 1.25rem;
}
.detail-item { display: flex; flex-direction: column; gap: 0.1rem; }
.detail-item.col-span-2 { grid-column: 1 / -1; }
.detail-label { font-size: 0.7rem; font-weight: 600; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.04em; }
.detail-value { font-size: 0.85rem; color: #0f172a; font-weight: 500; }
</style>
