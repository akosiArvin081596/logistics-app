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
            <TableRow v-for="app in applications" :key="app.id" class="hover:bg-blue-50/30 transition-colors">
              <TableCell class="font-semibold text-[13px] text-gray-900">{{ app.legal_name }}</TableCell>
              <TableCell class="text-[13px] text-gray-600">{{ app.entity_type || '-' }}</TableCell>
              <TableCell class="text-[13px] text-gray-600">{{ app.email }}</TableCell>
              <TableCell class="text-[13px] text-gray-600">{{ app.phone }}</TableCell>
              <TableCell class="text-[13px]">{{ app.signed_count || 0 }}/3</TableCell>
              <TableCell><Badge :class="obBadge(app.onboarding_status)">{{ app.onboarding_status || 'pending' }}</Badge></TableCell>
              <TableCell><Badge :class="statusBadge(app.status)">{{ app.status }}</Badge></TableCell>
              <TableCell class="text-right">
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
      <DialogContent class="sm:max-w-[600px] rounded-[14px] border-[#e8edf2] shadow-[0_8px_32px_rgba(0,0,0,0.12)] p-0 gap-0 overflow-hidden max-h-[85vh]">
        <DialogHeader class="px-6 pt-5 pb-4 border-b border-[#e8edf2]">
          <DialogTitle class="text-[1.1rem] font-bold text-gray-900">{{ selectedApp?.legal_name }}</DialogTitle>
          <DialogDescription class="text-[13px] text-gray-400">{{ selectedApp?.entity_type }} | {{ selectedApp?.email }}</DialogDescription>
        </DialogHeader>
        <div v-if="selectedApp" class="px-6 py-5 overflow-y-auto" style="max-height:60vh;">
          <div class="space-y-3 text-[13px]">
            <div class="grid grid-cols-2 gap-2">
              <div><span class="text-gray-400">DBA:</span> {{ selectedApp.dba || '-' }}</div>
              <div><span class="text-gray-400">Address:</span> {{ selectedApp.address }}</div>
              <div><span class="text-gray-400">Contact:</span> {{ selectedApp.contact_person }} {{ selectedApp.contact_title }}</div>
              <div><span class="text-gray-400">Phone:</span> {{ selectedApp.phone }}</div>
              <div><span class="text-gray-400">Tax:</span> {{ selectedApp.tax_classification }}</div>
              <div><span class="text-gray-400">EIN/SSN:</span> ***{{ (selectedApp.ein_ssn || '').slice(-4) }}</div>
              <div><span class="text-gray-400">Fleet Size:</span> {{ selectedApp.fleet_size || '-' }}</div>
              <div><span class="text-gray-400">Experience:</span> {{ selectedApp.industry_experience || '-' }}</div>
              <div><span class="text-gray-400">Bankruptcy:</span> {{ selectedApp.bankruptcy_liens || '-' }}</div>
              <div><span class="text-gray-400">Vehicle:</span> {{ selectedApp.vehicle_year }} {{ selectedApp.vehicle_make }} {{ selectedApp.vehicle_model }}</div>
              <div><span class="text-gray-400">VIN:</span> {{ selectedApp.vehicle_vin || '-' }}</div>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
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
const selectedApp = ref(null)
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

function viewDetail(app) {
  selectedApp.value = app
  showDetail.value = true
}

onMounted(load)
</script>
