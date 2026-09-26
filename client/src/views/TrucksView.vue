<template>
  <div class="trucks-page admin-page" style="overflow-y:auto;min-height:auto;flex:none;">
    <div class="page-header">
      <h2>Truck Database</h2>
      <!-- A reload keeps the table, and any open Edit dialog, on screen; this is
           the only sign that one is running. -->
      <span v-if="store.hasLoaded && store.isLoading" class="status-pill">Refreshing…</span>
    </div>

    <!-- KPI Summary -->
    <div class="kpi-grid" style="margin-bottom:1.25rem;">
      <Card v-for="card in kpiCards" :key="card.label" class="kpi-card" :class="card.theme">
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

    <details v-if="authStore.user?.role === 'Super Admin' || authStore.user?.role === 'Dispatcher'" class="form-accordion">
      <summary class="form-toggle">+ Add Truck</summary>
      <AddTruckForm
        :driver-names="store.driverNames"
        :investor-users="store.investorUsers"
        :show-owner="true"
        :can-edit-pay="authStore.user?.role === 'Super Admin'"
        :submit-handler="handleAddTruck"
      />
    </details>

    <!-- Until a load succeeds. Keyed on isLoading this unmounted TruckTable on
         every reload (a socket update, a save, a Routemate link), and took an
         open Edit dialog and everything typed into it down with it. A failed
         load shows why, with a Retry: an empty table here read as an empty
         fleet. -->
    <template v-if="!store.hasLoaded">
      <div v-if="store.loadError" class="error-state">
        <div role="alert">
          <div class="error-title">Could not load the trucks</div>
          <div class="error-msg">{{ store.loadError }}</div>
        </div>
        <button type="button" class="btn btn-primary" :disabled="store.isLoading" @click="loadPage">{{ store.isLoading ? 'Retrying…' : 'Retry' }}</button>
      </div>
      <SkeletonLoader v-else :rows="4" :cols="7" />
    </template>
    <template v-else>
      <!-- A reload that failed once the list was on screen: the list stays. -->
      <div v-if="store.loadError" class="refresh-error">
        <span role="alert">Couldn't refresh the list ({{ store.loadError }}). These are the trucks as last loaded.</span>
        <button type="button" class="btn btn-secondary btn-sm" :disabled="store.isLoading" @click="loadPage">{{ store.isLoading ? 'Retrying…' : 'Retry' }}</button>
      </div>
      <PaginationBar :page="page" :page-size="pageSize" :total="store.trucks.length" :total-pages="totalPages" @go="goTo" @size="setSize" />
      <!-- all-trucks: the whole fleet, not just this page, so an open Edit
           dialog can tell a deleted truck from one that moved to another page. -->
      <TruckTable
        :trucks="paginatedItems"
        :all-trucks="store.trucks"
        :driver-names="store.driverNames"
        :investor-users="store.investorUsers"
        :show-owner="authStore.user?.role === 'Super Admin'"
        :can-edit="authStore.user?.role === 'Super Admin' || authStore.user?.role === 'Dispatcher'"
        :can-edit-pay="authStore.user?.role === 'Super Admin'"
        :save-handler="handleUpdateTruck"
        @delete="handleDeleteTruck"
        @linkage-changed="handleLinkageChanged"
      />
    </template>
  </div>
</template>

<script setup>
import { onMounted, computed, watch } from 'vue'
import { useTrucksStore } from '../stores/trucks'
import { useAuthStore } from '../stores/auth'
import { useToast } from '../composables/useToast'
import { useSocketRefresh } from '../composables/useSocketRefresh'
import AddTruckForm from '../components/trucks/AddTruckForm.vue'
import TruckTable from '../components/trucks/TruckTable.vue'
import SkeletonLoader from '../components/shared/SkeletonLoader.vue'
import PaginationBar from '../components/shared/PaginationBar.vue'
import { usePagination } from '../composables/usePagination'
import { Card, CardContent } from '@/components/ui/card'

const store = useTrucksStore()
const authStore = useAuthStore()
const { show: toast } = useToast()
// Before the first render, so the page never draws the list an earlier visit
// left in the store (see resetList).
store.resetList()
// The driver-name list and the investor list both feed the EDIT form, and an
// Investor cannot edit a truck (PUT /api/trucks/:id is admin-only). Their
// endpoints are correspondingly admin-gated, so calling them here would just
// produce a swallowed 403 on every Investor page load.
const canEditTrucks = () =>
  authStore.user?.role === 'Super Admin' || authStore.user?.role === 'Dispatcher'

// The page opening, a live update and Retry. refreshList() never rejects: a
// failed load is shown from store.loadError, with a Retry.
function loadPage() {
  store.refreshList()
  if (canEditTrucks()) { store.loadDriverNames(); store.loadInvestorUsers() }
}

useSocketRefresh('trucks:changed', loadPage)

const { page, pageSize, totalPages, paginatedItems, goTo, setSize } = usePagination(computed(() => store.trucks), 25)
watch(totalPages, (tp) => { if (page.value > tp) goTo(tp) })

const kpiCards = computed(() => {
  const trucks = store.trucks
  const active = trucks.filter(t => t.Status === 'Active').length
  const maintenance = trucks.filter(t => t.Status === 'Maintenance' || t.Status === 'Out of Service').length
  const assigned = trucks.filter(t => (t.AssignedDriver || '').trim() !== '').length
  // A dash until a load succeeds, not a row of zeros that read as an empty
  // fleet (a failed first load included).
  const shown = (v) => (store.hasLoaded ? v : '—')
  return [
    { label: 'Total Trucks',   value: shown(trucks.length), sub: 'In fleet',           icon: '&#128663;', theme: 'kpi-blue',    iconTheme: 'kpi-icon-blue' },
    { label: 'Active',         value: shown(active),        sub: 'On the road',        icon: '&#9654;',   theme: 'kpi-emerald', iconTheme: 'kpi-icon-emerald' },
    { label: 'In Maintenance', value: shown(maintenance),   sub: 'Out of service',     icon: '&#128295;', theme: 'kpi-amber',   iconTheme: 'kpi-icon-amber' },
    { label: 'Assigned',       value: shown(`${assigned}/${trucks.length}`), sub: 'With a driver', icon: '&#128279;', theme: 'kpi-violet',  iconTheme: 'kpi-icon-violet' },
  ]
})

// Awaited by AddTruckForm, which clears its fields only once this resolves. A
// refusal is left to reject, not toasted: the form shows the server's reason
// under Add Truck and keeps everything typed. Both resolve as soon as the
// server has answered the write; the list reloads behind them (the store's
// writeThenRefresh).
async function handleAddTruck(data) {
  await store.addTruck(data)
  toast('Truck added')
}

// Awaited by TruckTable's Edit dialog, which closes only once this resolves. A
// refusal is left to reject, not toasted: the dialog shows the server's reason
// above Save and keeps everything typed.
async function handleUpdateTruck(id, data) {
  await store.updateTruck(id, data)
  toast('Truck updated')
}

// Routemate linkage events from TruckTable. Reload-only — the link/unlink
// API calls are made inside TruckTable, which emits only once one succeeded;
// we just refresh the table so the "Linked" badge appears (or disappears) on
// the affected row. Like a save, the confirmation does not wait for the
// reload, and a failed reload shows on the page (store.loadError).
function handleLinkageChanged() {
  toast('Routemate link updated')
  store.refreshList()
}

async function handleDeleteTruck(id) {
  try {
    await store.deleteTruck(id)
    toast('Truck deleted')
  } catch (err) {
    // The server's own reason: a truck that still has records attached names
    // them and what to detach first, which a generic failure hid.
    toast(err?.message || 'Failed to delete truck', 'error')
  }
}

onMounted(loadPage)
</script>

<style scoped>
/* Copied from FinancialsView/AnalyticsView: .error-state is scoped there, not
   global. */
.error-state {
  background: var(--danger-dim, #fef2f2);
  border: 1px solid var(--danger-dim, #fecaca);
  border-radius: 10px;
  padding: 1rem 1.25rem;
  color: var(--danger, #b91c1c);
}
.error-title { font-weight: 700; font-size: 0.95rem; }
.error-msg { font-size: 0.8rem; margin: 0.35rem 0 0.75rem; }
/* A failed reload over a list that is still shown: a line, not a card. */
.refresh-error {
  display: flex; align-items: center; flex-wrap: wrap; gap: 0.5rem 0.75rem;
  margin-bottom: 0.75rem; padding: 0.5rem 0.75rem;
  font-size: 0.78rem; line-height: 1.4;
  background: #fffbeb; color: #92400e;
  border: 1px solid #fde68a; border-radius: 6px;
}
.btn:disabled { opacity: 0.5; cursor: not-allowed; }
</style>
