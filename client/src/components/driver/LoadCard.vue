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

    <!-- Accept/Decline actions for pending loads -->
    <div v-if="pending && !accepted" class="card-actions">
      <button class="action-btn decline" @click.stop="$emit('decline', load)">Decline</button>
      <button class="action-btn accept" @click.stop="$emit('accept', load)">Accept</button>
    </div>
    <div v-else-if="pending && accepted" class="accepted-badge">
      Accepted
    </div>

    <!-- Bottom actions -->
    <div class="card-bottom">
      <div class="broker-info"></div>
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
  pending: { type: Boolean, default: false },
  accepted: { type: Boolean, default: false },
})

defineEmits(['select', 'chat', 'accept', 'decline'])

function findCol(headers, regex) {
  return (headers || []).find((h) => regex.test(h)) || null
}

const statusCol = computed(() => findCol(props.headers, /status/i))
const loadIdCol = computed(() => findCol(props.headers, /load.?id|job.?id/i))
const detailsCol = computed(() => findCol(props.headers, /details/i))
const originCol = computed(() => (props.headers || []).find(h => /origin|pickup.*city|shipper.*city/i.test(h) && !/lat|lng|lon/i.test(h)) || null)
const destCol = computed(() => (props.headers || []).find(h => /dest|drop.*city|receiver.*city|delivery.*city|consignee.*city/i.test(h) && !/lat|lng|lon|date|time|appt|eta/i.test(h)) || null)
const pickupCol = computed(() => findCol(props.headers, /pickup.*date|pickup.*appoint/i))
const delivCol = computed(() => findCol(props.headers, /drop.?off.*date|drop.?off.*appoint|deliv.*date|deliv.*appoint|completion.*date/i))

const status = computed(() => statusCol.value ? (props.load[statusCol.value] || '').trim() : '')
const loadId = computed(() => loadIdCol.value ? props.load[loadIdCol.value] : '')

const route = computed(() => {
  if (detailsCol.value) {
    const details = (props.load[detailsCol.value] || '').trim()
    if (details) return details.replace(/\s*-\s*/, ' \u2192 ')
  }
  const o = originCol.value ? props.load[originCol.value] : ''
  const d = destCol.value ? props.load[destCol.value] : ''
  if (o || d) return `${o || '\u2014'} \u2192 ${d || '\u2014'}`
  return ''
})

const pickupDate = computed(() => pickupCol.value ? props.load[pickupCol.value] : '')
const deliveryDate = computed(() => delivCol.value ? props.load[delivCol.value] : '')

function formatDate(str) {
  if (!str) return '\u2014'
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

.card-route {
  display: flex;
  align-items: flex-start;
  gap: 0.4rem;
  margin-bottom: 0.6rem;
  padding: 0.5rem 0.6rem;
  background: var(--bg);
  border-radius: 8px;
}

.route-icon { font-size: 0.8rem; flex-shrink: 0; margin-top: 0.05rem; }
.route-text { font-size: 0.8rem; font-weight: 500; color: var(--text); line-height: 1.35; }

.card-dates { display: flex; gap: 0.5rem; margin-bottom: 0.6rem; }

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

.date-icon { font-size: 0.7rem; font-weight: 700; color: var(--accent); }
.date-label { color: var(--text-dim); font-weight: 500; }
.date-value {
  font-weight: 600; color: var(--text); margin-left: auto;
  font-family: 'JetBrains Mono', monospace; font-size: 0.68rem;
}

/* Accept/Decline actions */
.card-actions {
  display: flex;
  gap: 0.5rem;
  margin-bottom: 0.6rem;
}
.action-btn {
  flex: 1;
  padding: 0.55rem;
  border-radius: 8px;
  font-family: inherit;
  font-size: 0.82rem;
  font-weight: 600;
  cursor: pointer;
  transition: opacity 0.15s;
}
.action-btn:active { opacity: 0.8; }
.action-btn.accept {
  background: var(--accent, #6366f1);
  color: #fff;
  border: none;
}
.action-btn.decline {
  background: var(--surface);
  color: var(--danger, #ef4444);
  border: 1px solid var(--danger, #ef4444);
}
.accepted-badge {
  text-align: center;
  padding: 0.4rem;
  margin-bottom: 0.6rem;
  background: #ecfdf5;
  color: #059669;
  font-size: 0.78rem;
  font-weight: 600;
  border-radius: 6px;
}

.card-bottom { display: flex; align-items: flex-end; justify-content: space-between; }

.broker-info { display: flex; flex-direction: column; gap: 0.1rem; min-width: 0; flex: 1; }

.chat-btn {
  width: 34px; height: 34px;
  border: 1px solid var(--border); border-radius: 50%;
  background: var(--surface); font-size: 0.9rem; cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  flex-shrink: 0; transition: background 0.15s, border-color 0.15s;
}

.chat-btn:active { background: var(--accent-dim); border-color: var(--accent); }
</style>
