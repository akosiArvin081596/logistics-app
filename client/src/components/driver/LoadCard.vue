<template>
  <div class="card load-card" @click="$emit('select', load)">
    <div class="card-header">
      <span class="card-title">{{ loadId || 'Load' }}</span>
      <div class="card-header-actions">
        <button class="chat-btn" title="Messages" @click.stop="$emit('chat', { loadId, load })">&#128172;</button>
        <StatusBadge :status="status" />
      </div>
    </div>
    <div v-if="origin || destination" class="card-row">
      <span class="card-label">Route</span>
      <span class="card-value">{{ origin || '\u2014' }} &rarr; {{ destination || '\u2014' }}</span>
    </div>
    <div v-if="pickupDate" class="card-row">
      <span class="card-label">Pickup</span>
      <span class="card-value">{{ formatDate(pickupDate) }}</span>
    </div>
    <div v-if="deliveryDate" class="card-row">
      <span class="card-label">Delivery</span>
      <span class="card-value">{{ formatDate(deliveryDate) }}</span>
    </div>
    <div v-if="broker" class="card-row">
      <span class="card-label">Broker</span>
      <span class="card-value">{{ broker }}</span>
    </div>
    <div v-if="rate" class="card-row">
      <span class="card-label">Rate</span>
      <span class="card-value">{{ formatCurrency(rate) }}</span>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import StatusBadge from '../shared/StatusBadge.vue'

const props = defineProps({
  load: { type: Object, required: true },
  headers: { type: Array, default: () => [] },
})

defineEmits(['select', 'chat'])

function findCol(headers, regex) {
  return (headers || []).find((h) => regex.test(h)) || null
}

const statusCol = computed(() => findCol(props.headers, /status/i))
const loadIdCol = computed(() => findCol(props.headers, /load.?id|job.?id/i))
const originCol = computed(() => findCol(props.headers, /origin|pickup.*city|shipper.*city/i))
const destCol = computed(() => findCol(props.headers, /dest|drop.*city|receiver.*city|delivery.*city|consignee.*city/i))
const pickupCol = computed(() => findCol(props.headers, /pickup.*date|pickup.*appt/i))
const delivCol = computed(() => findCol(props.headers, /deliv|drop.?off.*date|completion.*date/i))
const brokerCol = computed(() => findCol(props.headers, /broker/i))
const rateCol = computed(() => findCol(props.headers, /rate|amount/i))

const status = computed(() => statusCol.value ? (props.load[statusCol.value] || '').trim() : '')
const loadId = computed(() => loadIdCol.value ? props.load[loadIdCol.value] : '')
const origin = computed(() => originCol.value ? props.load[originCol.value] : '')
const destination = computed(() => destCol.value ? props.load[destCol.value] : '')
const pickupDate = computed(() => pickupCol.value ? props.load[pickupCol.value] : '')
const deliveryDate = computed(() => delivCol.value ? props.load[delivCol.value] : '')
const broker = computed(() => brokerCol.value ? props.load[brokerCol.value] : '')
const rate = computed(() => rateCol.value ? props.load[rateCol.value] : '')

function formatDate(str) {
  if (!str) return '\u2014'
  const d = new Date(str)
  if (isNaN(d)) return str
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function formatCurrency(val) {
  const n = parseFloat(String(val || '0').replace(/[$,]/g, ''))
  if (isNaN(n)) return val || '\u2014'
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })
}
</script>

<style scoped>
.load-card {
  cursor: pointer;
  transition: border-color 0.15s;
}

.load-card:hover {
  border-color: var(--accent);
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 0.75rem;
}

.card-header-actions {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.chat-btn {
  width: 30px;
  height: 30px;
  border: 1px solid var(--border);
  border-radius: 50%;
  background: var(--surface);
  font-size: 0.85rem;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.15s, border-color 0.15s;
}

.chat-btn:hover {
  background: var(--accent-dim);
  border-color: var(--accent);
}

.card-title {
  font-size: 0.95rem;
  font-weight: 600;
  font-family: 'JetBrains Mono', monospace;
}

.card-row {
  display: flex;
  justify-content: space-between;
  padding: 0.35rem 0;
  font-size: 0.85rem;
  border-bottom: 1px solid var(--bg);
}

.card-row:last-child {
  border-bottom: none;
}

.card-label {
  color: var(--text-dim);
}

.card-value {
  font-weight: 500;
  text-align: right;
  max-width: 60%;
  word-break: break-word;
}
</style>
