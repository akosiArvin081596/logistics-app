<template>
  <div class="trucks-page admin-page" style="overflow-y:auto;min-height:auto;flex:none;">
    <div class="page-header">
      <h2>Investor Database</h2>
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

    <details class="form-accordion">
      <summary class="form-toggle">+ Add Investor <span class="form-toggle-note">(Case-by-case basis only — should go through the proper application process)</span></summary>
      <AddInvestorForm @submit="handleAdd" />
    </details>

    <InvestorInvitesPanel />

    <!-- The skeleton is for the first read only. Keyed on isLoading alone it
         unmounted the table on every live update, save and avatar upload, and
         took the open detail modal with it. -->
    <template v-if="store.isLoading && !store.hasLoaded">
      <SkeletonLoader :rows="4" :cols="6" />
    </template>
    <div v-else-if="!store.hasLoaded && store.loadError" class="load-error" role="alert">
      <span>Couldn't load the investors ({{ store.loadError }}).</span>
      <button type="button" class="btn btn-secondary btn-sm" @click="store.refresh()">Retry</button>
    </div>
    <template v-else>
      <p v-if="store.loadError" class="load-error" role="alert">
        <span>Couldn't refresh the list ({{ store.loadError }}). These are the investors as last loaded.</span>
        <button type="button" class="btn btn-secondary btn-sm" @click="store.refresh()">Retry</button>
      </p>
      <PaginationBar :page="page" :page-size="pageSize" :total="store.investors.length" :total-pages="totalPages" @go="goTo" @size="setSize" />
      <InvestorTable
        :investors="paginatedItems"
        @delete="handleDelete"
        @update="handleUpdate"
        @picture-updated="store.refresh()"
      />
    </template>
  </div>
</template>

<script setup>
import { computed, watch } from 'vue'
import { useInvestorsStore } from '../stores/investors'
import { useToast } from '../composables/useToast'
import { useSocketRefresh } from '../composables/useSocketRefresh'
import AddInvestorForm from '../components/investors/AddInvestorForm.vue'
import InvestorTable from '../components/investors/InvestorTable.vue'
import InvestorInvitesPanel from '../components/investors/InvestorInvitesPanel.vue'
import SkeletonLoader from '../components/shared/SkeletonLoader.vue'
import PaginationBar from '../components/shared/PaginationBar.vue'
import { usePagination } from '../composables/usePagination'
import { Card, CardContent } from '@/components/ui/card'

const store = useInvestorsStore()
const { show: toast } = useToast()
useSocketRefresh('investors:changed', () => store.refresh())

// Started during setup, not on mount, so the first render already shows the
// skeleton rather than a flash of "No investors yet".
store.refresh()

const { page, pageSize, totalPages, paginatedItems, goTo, setSize } = usePagination(computed(() => store.investors), 25)
watch(totalPages, (tp) => { if (page.value > tp) goTo(tp) })

const kpiCards = computed(() => {
  const inv = store.investors
  const active = inv.filter(i => i.status === 'Active').length
  const totalTrucks = inv.reduce((sum, i) => sum + (i.truckCount || 0), 0)
  const onboarded = inv.filter(i => i.userId && i.userId > 0).length
  return [
    { label: 'Total Investors', value: inv.length,  sub: 'Registered owners',       icon: '&#128188;', theme: 'kpi-blue',    iconTheme: 'kpi-icon-blue' },
    { label: 'Active',          value: active,      sub: 'Currently operating',     icon: '&#10003;',  theme: 'kpi-emerald', iconTheme: 'kpi-icon-emerald' },
    { label: 'Fleet Owned',     value: totalTrucks, sub: `Across ${inv.length} investor${inv.length === 1 ? '' : 's'}`, icon: '&#128663;', theme: 'kpi-amber', iconTheme: 'kpi-icon-amber' },
    { label: 'With Login',      value: `${onboarded}/${inv.length}`, sub: 'Portal access',  icon: '&#128100;', theme: 'kpi-violet',  iconTheme: 'kpi-icon-violet' },
  ]
})

async function handleAdd(data) {
  try {
    await store.add(data)
    toast('Investor added')
  } catch (err) {
    toast(err.message || 'Failed to add investor', 'error')
  }
}

async function handleUpdate({ id, data }) {
  try {
    await store.update(id, data)
    toast('Investor updated')
  } catch (err) {
    toast(err.message || 'Failed to update investor', 'error')
  }
}

async function handleDelete(id) {
  try {
    await store.remove(id)
    toast('Investor deleted')
  } catch (err) {
    toast(err.message || 'Failed to delete investor', 'error')
  }
}
</script>

<style scoped>
.load-error {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  margin: 0 0 1rem;
  padding: 0.6rem 0.85rem;
  border-radius: var(--radius);
  background: var(--danger-dim);
  color: #b91c1c;
  font-size: 0.8rem;
}
</style>
