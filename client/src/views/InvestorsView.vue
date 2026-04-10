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
      <AddInvestorForm
        :carrier-names="store.carrierNames"
        @submit="handleAdd"
      />
    </details>

    <template v-if="store.isLoading">
      <SkeletonLoader :rows="4" :cols="6" />
    </template>
    <template v-else>
      <InvestorTable
        :investors="store.investors"
        :carrier-names="store.carrierNames"
        @delete="handleDelete"
        @update="handleUpdate"
        @picture-updated="store.load()"
      />
    </template>
  </div>
</template>

<script setup>
import { onMounted, computed } from 'vue'
import { useInvestorsStore } from '../stores/investors'
import { useToast } from '../composables/useToast'
import { useSocketRefresh } from '../composables/useSocketRefresh'
import AddInvestorForm from '../components/investors/AddInvestorForm.vue'
import InvestorTable from '../components/investors/InvestorTable.vue'
import SkeletonLoader from '../components/shared/SkeletonLoader.vue'
import { Card, CardContent } from '@/components/ui/card'

const store = useInvestorsStore()
const { show: toast } = useToast()
useSocketRefresh('investors:changed', () => store.load())

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
  } catch {
    toast('Failed to delete investor', 'error')
  }
}

onMounted(() => {
  store.load()
  store.loadCarrierNames()
})
</script>
