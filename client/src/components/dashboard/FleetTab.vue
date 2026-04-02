<template>
  <div class="fleet-wrap">
    <div v-if="fleet.length > 0" class="fleet-grid">
      <Card v-for="f in fleet" :key="f.Driver" class="fleet-card" @click="openDetail(f)">
        <template #content>
          <div class="card-top">
            <div>
              <div class="driver-name">{{ f.Driver || 'Unknown' }}</div>
              <div class="truck-id">{{ f.Truck || 'No truck assigned' }}</div>
            </div>
            <Tag :value="f.Status" :severity="f.Status === 'On Load' ? 'info' : 'success'" />
          </div>
          <div class="card-bottom">
            <span class="fleet-stat">{{ f.CompletedLoads }} completed</span>
            <span v-if="f.CurrentLoad" class="load-id">{{ f.CurrentLoad }}</span>
          </div>
        </template>
      </Card>
    </div>
    <EmptyState v-else>No carriers found.</EmptyState>

    <!-- Driver Detail -->
    <Dialog v-model:visible="showDriver" :header="selected?.Driver || 'Driver'" modal :style="{ width: '480px', maxWidth: '95vw' }" :dismissable-mask="true">
      <template v-if="selected">
        <div class="detail-section">
          <div class="section-label">Status</div>
          <div class="section-card">
            <div class="card-row">
              <span class="field-label">Availability</span>
              <span class="field-value"><Tag :value="selected.Status" :severity="selected.Status === 'On Load' ? 'info' : 'success'" /></span>
            </div>
            <div class="card-row">
              <span class="field-label">Current Load</span>
              <span class="field-value">
                <a v-if="selected.CurrentLoad" class="load-link" @click.stop="openLoadDetail">{{ selected.CurrentLoad }}</a>
                <template v-else>&mdash;</template>
              </span>
            </div>
          </div>
        </div>
        <div class="detail-section">
          <div class="section-label">Performance</div>
          <div class="section-card">
            <div class="card-row full-width">
              <span class="field-label">Completed Loads</span>
              <span class="field-value" style="font-size:1.2rem;font-weight:700;font-family:'JetBrains Mono',monospace;">{{ selected.CompletedLoads }}</span>
            </div>
          </div>
        </div>
        <div v-if="selected.Phone" class="detail-section">
          <div class="section-label">Contact</div>
          <div class="section-card">
            <div class="card-row full-width">
              <span class="field-label">Phone</span>
              <span class="field-value">{{ selected.Phone }}</span>
            </div>
          </div>
        </div>
      </template>
    </Dialog>

    <!-- Load Detail -->
    <Dialog v-model:visible="showLoad" :header="selectedLoadId || 'Load Details'" modal :style="{ width: '680px', maxWidth: '95vw' }" :dismissable-mask="true">
      <template v-if="selectedLoad">
        <template v-for="section in loadSections" :key="section.title">
          <div v-if="section.fields.length" class="detail-section">
            <div class="section-label">{{ section.title }}</div>
            <div class="section-card">
              <div v-for="field in section.fields" :key="field.col" :class="['card-row', { 'full-width': field.wide }]">
                <span class="field-label">{{ field.col }}</span>
                <span class="field-value">
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

const props = defineProps({
  fleet: { type: Array, required: true },
  activeJobs: { type: Array, default: () => [] },
  headers: { type: Array, default: () => [] },
})

const selected = ref(null)
const showDriver = ref(false)
const selectedLoad = ref(null)
const showLoad = ref(false)

function openDetail(f) { selected.value = f; showDriver.value = true }

function openLoadDetail() {
  if (!selected.value?.CurrentLoad || !props.headers.length) return
  const lc = props.headers.find(h => /load.?id|job.?id/i.test(h))
  if (!lc) return
  const job = props.activeJobs.find(j => (j[lc] || '').trim() === selected.value.CurrentLoad.trim())
  if (job) { selectedLoad.value = job; showLoad.value = true }
}

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
  if (!selectedLoad.value) return []
  const used = new Set(); const secs = []
  for (const c of props.headers) { if (hiddenCols.test(c)) used.add(c) }
  for (const sp of sectionPatterns) { const f = []; for (const c of props.headers) { if (used.has(c)) continue; if (sp.test.test(c)) { used.add(c); f.push({ col: c, value: loadDetailValue(selectedLoad.value, c), wide: sp.wide ? sp.wide.test(c) : false }) } }; secs.push({ title: sp.title, fields: f }) }
  const rem = []; for (const c of props.headers) { if (used.has(c)) continue; rem.push({ col: c, value: loadDetailValue(selectedLoad.value, c), wide: false }) }
  if (rem.length) secs.push({ title: 'Other Details', fields: rem })
  return secs.filter(s => s.fields.length > 0)
})
</script>

<style scoped>
.fleet-wrap { padding: 1.25rem; }
.fleet-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 1rem; }
.fleet-card { cursor: pointer; transition: transform 0.15s; }
.fleet-card:hover { transform: translateY(-2px); }
:deep(.p-card-body) { padding: 1rem; }
:deep(.p-card-content) { padding: 0; }
.card-top { display: flex; justify-content: space-between; align-items: flex-start; }
.driver-name { font-weight: 700; font-size: 0.95rem; }
.truck-id { font-family: 'JetBrains Mono', monospace; font-size: 0.78rem; color: var(--text-dim); }
.card-bottom { margin-top: 0.75rem; display: flex; align-items: center; gap: 0.5rem; }
.fleet-stat { font-size: 0.75rem; color: var(--text-dim); }
.load-id { font-family: 'JetBrains Mono', monospace; font-size: 0.72rem; color: var(--blue); }
.load-link { color: var(--blue); cursor: pointer; text-decoration: underline; font-family: 'JetBrains Mono', monospace; font-size: 0.85rem; }

.detail-section { margin-bottom: 1.25rem; }
.detail-section:last-child { margin-bottom: 0; }
.section-label { font-size: 0.68rem; font-weight: 700; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 0.5rem; }
.section-card { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; display: grid; grid-template-columns: 1fr 1fr; overflow: hidden; }
.card-row { display: flex; flex-direction: column; gap: 0.15rem; padding: 0.7rem 1rem; border-bottom: 1px solid var(--border); }
.card-row.full-width { grid-column: 1 / -1; }
.card-row:last-child { border-bottom: none; }
.field-label { font-size: 0.68rem; font-weight: 600; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.02em; }
.field-value { font-size: 0.88rem; font-weight: 500; word-break: break-word; }
</style>
