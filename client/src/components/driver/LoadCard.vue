<template>
  <div class="load-card" @click="$emit('select', load)">
    <!-- Top: Load ID + Status -->
    <div class="card-top">
      <span class="load-id">{{ loadId || 'Load' }}</span>
      <StatusBadge :status="status" />
    </div>

    <!-- Route -->
    <div v-if="route" class="card-route">
      <span class="route-icon">&#128205;</span>
      <span class="route-text">{{ route }}</span>
    </div>

    <!-- Dates row -->
    <div v-if="pickupDate || deliveryDate" class="card-dates">
      <div v-if="pickupDate" class="date-item">
        <span class="date-icon">&#8593;</span>
        <span class="date-label">Pickup</span>
        <span class="date-value">{{ formatDate(pickupDate) }}</span>
      </div>
      <div v-if="deliveryDate" class="date-item">
        <span class="date-icon">&#8595;</span>
        <span class="date-label">Delivery</span>
        <span class="date-value">{{ formatDate(deliveryDate) }}</span>
      </div>
    </div>

    <!-- Broker & bottom actions -->
    <div class="card-bottom">
      <div class="broker-info">
        <template v-if="brokerName">
          <span class="broker-name">{{ brokerName }}</span>
          <span v-if="brokerEmail" class="broker-email">{{ brokerEmail }}</span>
        </template>
      </div>
      <button class="chat-btn" title="Messages" @click.stop="$emit('chat', { loadId, load })">&#128172;</button>
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
const detailsCol = computed(() => findCol(props.headers, /details/i))
const originCol = computed(() => findCol(props.headers, /origin|pickup.*city|shipper.*city/i))
const destCol = computed(() => findCol(props.headers, /dest|drop.*city|receiver.*city|delivery.*city|consignee.*city/i))
const pickupCol = computed(() => findCol(props.headers, /pickup.*date|pickup.*appt/i))
const delivCol = computed(() => findCol(props.headers, /drop.?off.*date|drop.?off.*appt|deliv.*date|deliv.*appt|completion.*date/i))
const brokerCol = computed(() => findCol(props.headers, /broker/i))

const status = computed(() => statusCol.value ? (props.load[statusCol.value] || '').trim() : '')
const loadId = computed(() => loadIdCol.value ? props.load[loadIdCol.value] : '')

// Route: prefer Details column (e.g. "Conroe, TX, 77303 - Wilmer, TX, 75146"), fall back to origin/dest
const route = computed(() => {
  if (detailsCol.value) {
    const details = (props.load[detailsCol.value] || '').trim()
    if (details) return details.replace(/\s*-\s*/, ' → ')
  }
  const o = originCol.value ? props.load[originCol.value] : ''
  const d = destCol.value ? props.load[destCol.value] : ''
  if (o || d) return `${o || '\u2014'} \u2192 ${d || '\u2014'}`
  return ''
})

const pickupDate = computed(() => pickupCol.value ? props.load[pickupCol.value] : '')
const deliveryDate = computed(() => delivCol.value ? props.load[delivCol.value] : '')

const brokerParsed = computed(() => {
  if (!brokerCol.value) return { name: '', email: '', phone: '' }
  const raw = props.load[brokerCol.value] || ''
  try {
    const parsed = JSON.parse(raw)
    return { name: parsed.Name || '', email: parsed.Email || '', phone: parsed.Phone || '' }
  } catch {
    return { name: raw, email: '', phone: '' }
  }
})
const brokerName = computed(() => brokerParsed.value.name)
const brokerEmail = computed(() => brokerParsed.value.email)

function formatDate(str) {
  if (!str) return '\u2014'
  // Strip time ranges like "06:00-18:00" → "06:00" so Date can parse
  const cleaned = str.replace(/(\d{1,2}:\d{2})\s*-\s*\d{1,2}:\d{2}/, '$1').trim()
  const d = new Date(cleaned)
  if (isNaN(d)) return str
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}
</script>

<style scoped>
.load-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 0.85rem 1rem;
  margin-bottom: 0.6rem;
  cursor: pointer;
  transition: border-color 0.15s, box-shadow 0.15s;
}

.load-card:active {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px var(--accent-dim);
}

/* Top row: Load ID + Status */
.card-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 0.6rem;
}

.load-id {
  font-size: 0.92rem;
  font-weight: 700;
  font-family: 'JetBrains Mono', monospace;
  letter-spacing: -0.02em;
}

/* Route */
.card-route {
  display: flex;
  align-items: flex-start;
  gap: 0.4rem;
  margin-bottom: 0.6rem;
  padding: 0.5rem 0.6rem;
  background: var(--bg);
  border-radius: 8px;
}

.route-icon {
  font-size: 0.8rem;
  flex-shrink: 0;
  margin-top: 0.05rem;
}

.route-text {
  font-size: 0.8rem;
  font-weight: 500;
  color: var(--text);
  line-height: 1.35;
}

/* Dates */
.card-dates {
  display: flex;
  gap: 0.5rem;
  margin-bottom: 0.6rem;
}

.date-item {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 0.3rem;
  padding: 0.35rem 0.5rem;
  background: var(--bg);
  border-radius: 6px;
  font-size: 0.72rem;
}

.date-icon {
  font-size: 0.7rem;
  font-weight: 700;
  color: var(--accent);
}

.date-label {
  color: var(--text-dim);
  font-weight: 500;
}

.date-value {
  font-weight: 600;
  color: var(--text);
  margin-left: auto;
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.68rem;
}

/* Bottom: broker + chat */
.card-bottom {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
}

.broker-info {
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
  min-width: 0;
  flex: 1;
}

.broker-name {
  font-size: 0.78rem;
  font-weight: 600;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.broker-email {
  font-size: 0.68rem;
  color: var(--text-dim);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.chat-btn {
  width: 34px;
  height: 34px;
  border: 1px solid var(--border);
  border-radius: 50%;
  background: var(--surface);
  font-size: 0.9rem;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  transition: background 0.15s, border-color 0.15s;
}

.chat-btn:active {
  background: var(--accent-dim);
  border-color: var(--accent);
}
</style>
