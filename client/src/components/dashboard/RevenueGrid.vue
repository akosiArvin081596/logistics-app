<template>
  <div>
    <div class="kpi-grid" style="grid-template-columns:repeat(3,1fr);">
      <Card
        v-for="card in cards"
        :key="card.key"
        class="kpi-card hover:shadow-md transition-shadow"
        style="border:1px solid #e8edf2;cursor:pointer;"
        role="button"
        tabindex="0"
        :aria-label="`Show ${card.label} breakdown`"
        @click="openBreakdown(card.key)"
        @keyup.enter="openBreakdown(card.key)"
        @keyup.space.prevent="openBreakdown(card.key)"
      >
        <CardContent class="flex items-center gap-4" style="padding:1rem 1.25rem;">
          <div :class="['kpi-icon', card.iconTheme]">{{ card.icon }}</div>
          <div class="kpi-info">
            <div class="kpi-label">{{ card.label }}</div>
            <div class="kpi-value">{{ card.value }}</div>
          </div>
        </CardContent>
      </Card>
    </div>

    <Dialog :open="!!open" @update:open="v => { if (!v) closeBreakdown() }">
      <DialogContent class="max-w-[880px] max-h-[88vh] flex flex-col overflow-hidden" style="padding:0;">
        <DialogHeader class="border-b border-gray-100 bg-muted/50" style="padding:1.25rem 1.5rem;">
          <DialogTitle>{{ dialogTitle }}</DialogTitle>
          <DialogDescription>
            {{ totalRowCount }} load{{ totalRowCount === 1 ? '' : 's' }} · {{ fmt(displayedSum) }}
            <span v-if="Math.abs(drift) >= 1" style="color:#b45309;">
              · Card shows {{ fmt(cardSum) }} (difference: {{ fmt(Math.abs(drift)) }} — likely canceled or uncategorized loads)
            </span>
          </DialogDescription>
        </DialogHeader>
        <div style="padding:1rem 1.5rem;overflow-y:auto;flex:1;">
          <template v-for="section in sections" :key="section.label">
            <h3
              v-if="sections.length > 1"
              class="text-sm font-semibold text-gray-700 uppercase tracking-wide"
              style="margin:0.75rem 0 0.5rem;"
            >
              {{ section.label }} — {{ fmt(sectionTotal(section)) }}
            </h3>
            <div v-if="section.items.length" class="overflow-x-auto" style="margin-bottom:1rem;">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Load ID</TableHead>
                    <TableHead>Driver</TableHead>
                    <TableHead>Route</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead class="text-right">Amount</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <TableRow v-for="item in section.items" :key="item.key">
                    <TableCell style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:0.8125rem;">{{ item.loadId || '—' }}</TableCell>
                    <TableCell>{{ item.driver || '—' }}</TableCell>
                    <TableCell>{{ item.origin || '—' }} → {{ item.dest || '—' }}</TableCell>
                    <TableCell>{{ item.status || '—' }}</TableCell>
                    <TableCell class="text-right" style="font-variant-numeric:tabular-nums;font-weight:600;">{{ fmt(item.amount) }}</TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </div>
            <div v-else style="padding:2rem;text-align:center;color:#9ca3af;font-size:0.875rem;">
              No loads with amounts in this bucket.
            </div>
          </template>
        </div>
      </DialogContent>
    </Dialog>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'
import { Card, CardContent } from '@/components/ui/card'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { useDashboardStore } from '../../stores/dashboard'

const props = defineProps({ revenue: { type: Object, required: true } })
const store = useDashboardStore()
const open = ref(null)

function fmt(n) { return '$' + Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 }) }
function parseAmount(v) { return parseFloat(String(v || '0').replace(/[$,]/g, '')) || 0 }

const cards = computed(() => [
  { key: 'total', icon: '$', label: 'Total Revenue', value: fmt(props.revenue.total), iconTheme: 'kpi-icon-blue' },
  { key: 'paid', icon: '✓', label: 'Paid', value: fmt(props.revenue.paid), iconTheme: 'kpi-icon-emerald' },
  { key: 'pending', icon: '◔', label: 'Pending', value: fmt(props.revenue.pending), iconTheme: 'kpi-icon-amber' },
])

const loadIdCol = computed(() => store.headers.find(h => /load.?id|job.?id/i.test(h)))
const driverCol = computed(() => store.headers.find(h => /driver/i.test(h)))
const originCol = computed(() => store.headers.find(h => /origin|pickup.*city|shipper.*city/i.test(h) && !/lat|lng|lon/i.test(h)))
const destCol   = computed(() => store.headers.find(h => /dest|drop.*city|receiver.*city|delivery.*city|consignee.*city/i.test(h) && !/lat|lng|lon|date|time|appt|eta/i.test(h)))
const statusCol = computed(() => store.headers.find(h => /status/i.test(h)))
const payCol    = computed(() => store.headers.find(h => /payment|rate|amount|pay/i.test(h)))

function toItem(row) {
  return {
    key:    row._rowIndex ?? (loadIdCol.value ? row[loadIdCol.value] : Math.random()),
    loadId: loadIdCol.value ? row[loadIdCol.value] || '' : '',
    driver: driverCol.value ? row[driverCol.value] || '' : '',
    origin: originCol.value ? row[originCol.value] || '' : '',
    dest:   destCol.value   ? row[destCol.value]   || '' : '',
    status: statusCol.value ? (row[statusCol.value] || '').trim() : '',
    amount: parseAmount(payCol.value ? row[payCol.value] : 0),
  }
}

const paidItems = computed(() =>
  store.completedJobs.map(toItem).filter(i => i.amount > 0)
    .sort((a, b) => b.amount - a.amount || (a.loadId || '').localeCompare(b.loadId || ''))
)
const pendingItems = computed(() =>
  [...store.activeJobs, ...store.unassignedJobs].map(toItem).filter(i => i.amount > 0)
    .sort((a, b) => b.amount - a.amount || (a.loadId || '').localeCompare(b.loadId || ''))
)

const sections = computed(() => {
  if (open.value === 'paid')    return [{ label: 'Paid',    items: paidItems.value    }]
  if (open.value === 'pending') return [{ label: 'Pending', items: pendingItems.value }]
  if (open.value === 'total')   return [
    { label: 'Paid',    items: paidItems.value },
    { label: 'Pending', items: pendingItems.value },
  ]
  return []
})

const totalRowCount = computed(() => sections.value.reduce((n, s) => n + s.items.length, 0))
const displayedSum  = computed(() => sections.value.reduce((t, s) => t + s.items.reduce((ss, i) => ss + i.amount, 0), 0))
const cardSum       = computed(() => (open.value ? props.revenue[open.value] || 0 : 0))
const drift         = computed(() => Math.round(cardSum.value - displayedSum.value))

const dialogTitle = computed(() => ({
  total:   'Total Revenue Breakdown',
  paid:    'Paid Revenue Breakdown',
  pending: 'Pending Revenue Breakdown',
}[open.value] || ''))

function sectionTotal(section) { return section.items.reduce((s, i) => s + i.amount, 0) }
function openBreakdown(key) { open.value = key }
function closeBreakdown() { open.value = null }
</script>
