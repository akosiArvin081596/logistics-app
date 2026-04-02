<template>
  <div class="p-3">
    <div v-if="fleet.length > 0" class="grid grid-cols-auto gap-3">
      <Card v-for="f in fleet" :key="f.Driver" class="cursor-pointer" :pt="{ body: { style: 'padding: 1rem' }, content: { style: 'padding: 0' } }" @click="openDetail(f)">
        <template #content>
          <div class="flex justify-content-between align-items-start mb-3">
            <div>
              <div class="font-bold text-base">{{ f.Driver || 'Unknown' }}</div>
              <div class="text-xs text-color-secondary font-mono">{{ f.Truck || 'No truck assigned' }}</div>
            </div>
            <Tag :value="f.Status" :severity="f.Status === 'On Load' ? 'info' : 'success'" />
          </div>
          <div class="flex align-items-center gap-2">
            <span class="text-xs text-color-secondary">{{ f.CompletedLoads }} completed</span>
            <span v-if="f.CurrentLoad" class="text-xs font-mono" style="color:var(--p-primary-color);">{{ f.CurrentLoad }}</span>
          </div>
        </template>
      </Card>
    </div>
    <EmptyState v-else>No carriers found.</EmptyState>

    <Dialog v-model:visible="showDriver" :header="selected?.Driver || 'Driver'" modal :style="{ width: '480px', maxWidth: '95vw' }" :dismissable-mask="true">
      <template v-if="selected">
        <div class="mb-3">
          <div class="text-xs font-bold text-color-secondary uppercase mb-2" style="letter-spacing:0.06em;">Status</div>
          <div class="surface-card border-1 surface-border border-round-lg overflow-hidden grid grid-cols-2">
            <div class="flex flex-column gap-1 p-3 border-bottom-1 surface-border">
              <span class="text-xs font-semibold text-color-secondary uppercase">Availability</span>
              <span class="text-sm"><Tag :value="selected.Status" :severity="selected.Status === 'On Load' ? 'info' : 'success'" /></span>
            </div>
            <div class="flex flex-column gap-1 p-3 border-bottom-1 surface-border">
              <span class="text-xs font-semibold text-color-secondary uppercase">Current Load</span>
              <span class="text-sm font-medium">
                <a v-if="selected.CurrentLoad" class="cursor-pointer" style="color:var(--p-primary-color);text-decoration:underline;" @click.stop="openLoadDetail">{{ selected.CurrentLoad }}</a>
                <template v-else>&mdash;</template>
              </span>
            </div>
          </div>
        </div>
        <div class="mb-3">
          <div class="text-xs font-bold text-color-secondary uppercase mb-2" style="letter-spacing:0.06em;">Performance</div>
          <div class="surface-card border-1 surface-border border-round-lg p-3">
            <span class="text-xs font-semibold text-color-secondary uppercase">Completed Loads</span>
            <div class="text-2xl font-bold font-mono mt-1">{{ selected.CompletedLoads }}</div>
          </div>
        </div>
        <div v-if="selected.Phone" class="mb-3">
          <div class="text-xs font-bold text-color-secondary uppercase mb-2" style="letter-spacing:0.06em;">Contact</div>
          <div class="surface-card border-1 surface-border border-round-lg p-3">
            <span class="text-xs font-semibold text-color-secondary uppercase">Phone</span>
            <div class="text-sm font-medium mt-1">{{ selected.Phone }}</div>
          </div>
        </div>
      </template>
    </Dialog>

    <Dialog v-model:visible="showLoad" :header="selectedLoadId || 'Load Details'" modal :style="{ width: '680px', maxWidth: '95vw' }" :dismissable-mask="true">
      <template v-if="selectedLoad">
        <template v-for="section in loadSections" :key="section.title">
          <div v-if="section.fields.length" class="mb-3">
            <div class="text-xs font-bold text-color-secondary uppercase mb-2" style="letter-spacing:0.06em;">{{ section.title }}</div>
            <div class="surface-card border-1 surface-border border-round-lg overflow-hidden grid grid-cols-2">
              <div v-for="field in section.fields" :key="field.col" :class="['flex flex-column gap-1 p-3 border-bottom-1 surface-border', { 'col-span-2': field.wide }]">
                <span class="text-xs font-semibold text-color-secondary uppercase">{{ field.col }}</span>
                <span class="text-sm font-medium">
                  <StatusBadge v-if="/status/i.test(field.col) && field.value" :status="field.value" />
                  <template v-else>{{ field.value || '\u2014' }}</template>
                </span>
              </div>
            </div>
          </div>
        </template>
      </template>
    </Dialog>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'
import Card from 'primevue/card'
import Dialog from 'primevue/dialog'
import Tag from 'primevue/tag'
import EmptyState from '../shared/EmptyState.vue'
import StatusBadge from '../shared/StatusBadge.vue'

const props = defineProps({ fleet: { type: Array, required: true }, activeJobs: { type: Array, default: () => [] }, headers: { type: Array, default: () => [] } })
const selected = ref(null); const showDriver = ref(false); const selectedLoad = ref(null); const showLoad = ref(false)
function openDetail(f) { selected.value = f; showDriver.value = true }
function openLoadDetail() { if (!selected.value?.CurrentLoad || !props.headers.length) return; const lc = props.headers.find(h => /load.?id|job.?id/i.test(h)); if (!lc) return; const job = props.activeJobs.find(j => (j[lc] || '').trim() === selected.value.CurrentLoad.trim()); if (job) { selectedLoad.value = job; showLoad.value = true } }
function parseJsonCell(r) { if (!r || typeof r !== 'string' || r[0] !== '{') return null; try { return JSON.parse(r) } catch { return null } }
function loadDetailValue(j, c) { const v = j[c] || ''; const p = parseJsonCell(v); return p ? Object.entries(p).filter(([,x]) => x).map(([k,x]) => `${k}: ${x}`).join(', ') : v }
const sectionPatterns = [
  { title: 'Load Information', test: /load|job|id|status|driver|truck|trailer|equipment|type|commodity|weight|miles|details/i, wide: /details|commodity/i },
  { title: 'Route', test: /origin|pickup|shipper|dest|drop|receiver|delivery|consignee|city|state|zip|address|location/i, wide: /address/i },
  { title: 'Schedule', test: /date|time|pickup.*date|delivery.*date|appointment|eta|scheduled/i },
  { title: 'Financials', test: /rate|amount|revenue|pay|charge|price|cost|invoice|total/i },
]
const hiddenCols = /broker|phone|email|contact|contract/i
const selectedLoadId = computed(() => { if (!selectedLoad.value) return ''; const c = props.headers.find(h => /load.?id|job.?id/i.test(h)); return c ? selectedLoad.value[c] || '' : '' })
const loadSections = computed(() => {
  if (!selectedLoad.value) return []; const used = new Set(); const secs = []
  for (const c of props.headers) { if (hiddenCols.test(c)) used.add(c) }
  for (const sp of sectionPatterns) { const f = []; for (const c of props.headers) { if (used.has(c)) continue; if (sp.test.test(c)) { used.add(c); f.push({ col: c, value: loadDetailValue(selectedLoad.value, c), wide: sp.wide ? sp.wide.test(c) : false }) } }; secs.push({ title: sp.title, fields: f }) }
  const rem = []; for (const c of props.headers) { if (used.has(c)) continue; rem.push({ col: c, value: loadDetailValue(selectedLoad.value, c), wide: false }) }
  if (rem.length) secs.push({ title: 'Other Details', fields: rem }); return secs.filter(s => s.fields.length > 0)
})
</script>

<style scoped>
.grid-cols-auto { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); }
.grid-cols-2 { display: grid; grid-template-columns: 1fr 1fr; }
.col-span-2 { grid-column: 1 / -1; }
.font-mono { font-family: 'JetBrains Mono', monospace; }
</style>
