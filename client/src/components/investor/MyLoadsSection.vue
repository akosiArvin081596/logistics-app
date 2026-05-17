<template>
  <div class="section-card">
    <div class="section-header-row">
      <h3 class="section-title">My Loads</h3>
      <span class="section-count">{{ pending.length + active.length }}</span>
    </div>

    <!-- Pending -->
    <div class="bucket">
      <div class="bucket-header">
        <span class="bucket-label">Pending</span>
        <span class="bucket-count">{{ pending.length }}</span>
        <span class="bucket-hint">Assigned to your trucks, not yet picked up</span>
      </div>
      <div v-if="pending.length === 0" class="empty-msg">No pending loads on your trucks.</div>
      <ul v-else class="load-list">
        <li v-for="l in pending" :key="'p-'+l.loadId" class="load-row">
          <div class="row-main">
            <span class="load-id mono bold">{{ l.loadId || '—' }}</span>
            <span class="route">
              <span class="loc">{{ l.pickup || '—' }}</span>
              <span class="arrow">→</span>
              <span class="loc">{{ l.dropoff || '—' }}</span>
            </span>
          </div>
          <div class="row-meta">
            <span class="meta-truck" v-if="l.truck">Truck {{ l.truck }}</span>
            <span class="meta-driver" v-if="l.driver">{{ l.driver }}</span>
            <span :class="['status-pill', 'pill-amber']">{{ l.status }}</span>
            <span class="share mono" :title="`Your share at ${splitPct}% split`">{{ fmtMoney(l.yourShare) }}</span>
          </div>
        </li>
      </ul>
    </div>

    <!-- Active -->
    <div class="bucket">
      <div class="bucket-header">
        <span class="bucket-label">Active</span>
        <span class="bucket-count">{{ active.length }}</span>
        <span class="bucket-hint">In-transit / at shipper / at receiver</span>
      </div>
      <div v-if="active.length === 0" class="empty-msg">No active loads on your trucks.</div>
      <ul v-else class="load-list">
        <li v-for="l in active" :key="'a-'+l.loadId" class="load-row">
          <div class="row-main">
            <span class="load-id mono bold">{{ l.loadId || '—' }}</span>
            <span class="route">
              <span class="loc">{{ l.pickup || '—' }}</span>
              <span class="arrow">→</span>
              <span class="loc">{{ l.dropoff || '—' }}</span>
            </span>
          </div>
          <div class="row-meta">
            <span class="meta-truck" v-if="l.truck">Truck {{ l.truck }}</span>
            <span class="meta-driver" v-if="l.driver">{{ l.driver }}</span>
            <span :class="['status-pill', 'pill-green']">{{ l.status }}</span>
            <span class="share mono" :title="`Your share at ${splitPct}% split`">{{ fmtMoney(l.yourShare) }}</span>
          </div>
        </li>
      </ul>
    </div>

    <p class="footnote">
      "Your Share" is an estimate based on the configured investor split
      (gross &times; {{ splitPct }}%). Final take-home is reconciled in the monthly
      earnings breakdown after driver pay and expenses are deducted.
    </p>
  </div>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  myLoads: { type: Object, default: () => ({ pending: [], active: [] }) },
  config: { type: Object, default: () => ({}) },
})

const pending = computed(() => props.myLoads?.pending || [])
const active = computed(() => props.myLoads?.active || [])
const splitPct = computed(() => {
  const raw = parseFloat(props.config?.investor_split_pct)
  return Number.isFinite(raw) ? raw : 50
})

function fmtMoney(n) {
  const v = Number(n || 0)
  return '$' + v.toLocaleString('en-US')
}
</script>

<style scoped>
.section-card {
  background: var(--surface); border-radius: var(--radius); border: 1px solid var(--border);
  padding: 1.25rem; margin-bottom: 1.25rem;
}
.section-header-row { display: flex; align-items: center; justify-content: space-between; margin-bottom: 1rem; }
.section-title { font-size: 1rem; font-weight: 700; }
.section-count {
  font-size: 0.72rem; font-weight: 700; background: var(--accent-dim); color: var(--accent);
  padding: 0.15rem 0.5rem; border-radius: 99px;
}
.bucket { margin-bottom: 1.25rem; }
.bucket:last-of-type { margin-bottom: 0.5rem; }
.bucket-header {
  display: flex; align-items: center; gap: 0.6rem;
  margin-bottom: 0.5rem;
}
.bucket-label {
  font-size: 0.75rem; font-weight: 700; text-transform: uppercase;
  letter-spacing: 0.05em; color: var(--text);
}
.bucket-count {
  font-size: 0.7rem; font-weight: 700;
  background: var(--bg); color: var(--text-dim);
  padding: 0.1rem 0.45rem; border-radius: 99px;
}
.bucket-hint {
  font-size: 0.7rem; color: var(--text-dim);
}
.empty-msg {
  text-align: center; padding: 1rem; color: var(--text-dim);
  font-size: 0.8rem; background: var(--bg); border-radius: 6px;
}
.load-list { list-style: none; padding: 0; margin: 0; }
.load-row {
  display: flex; align-items: center; justify-content: space-between;
  gap: 0.75rem; padding: 0.6rem 0.5rem;
  border-bottom: 1px solid var(--bg);
}
.load-row:last-child { border-bottom: none; }
.row-main {
  display: flex; align-items: center; gap: 0.75rem;
  min-width: 0; flex: 1;
}
.load-id { font-size: 0.85rem; white-space: nowrap; }
.route {
  display: flex; align-items: center; gap: 0.4rem;
  font-size: 0.82rem; color: var(--text);
  min-width: 0; flex: 1;
}
.loc {
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  max-width: 18ch;
}
.arrow { color: var(--text-dim); font-weight: 600; }
.row-meta {
  display: flex; align-items: center; gap: 0.6rem;
  flex-shrink: 0;
}
.meta-truck, .meta-driver {
  font-size: 0.72rem; color: var(--text-dim);
}
.share { font-size: 0.88rem; font-weight: 700; color: var(--accent); }
.status-pill {
  font-size: 0.68rem; font-weight: 600; padding: 0.15rem 0.5rem; border-radius: 99px;
}
.pill-green { background: #d1fae5; color: #065f46; }
.pill-amber { background: #fef3c7; color: #92400e; }
.mono { font-family: 'JetBrains Mono', monospace; }
.bold { font-weight: 700; }
.footnote {
  margin-top: 1rem; padding-top: 0.75rem;
  border-top: 1px dashed var(--border);
  font-size: 0.7rem; color: var(--text-dim); font-style: italic;
}

@media (max-width: 640px) {
  .load-row {
    flex-direction: column; align-items: stretch; gap: 0.4rem;
  }
  .row-main {
    flex-direction: column; align-items: flex-start; gap: 0.25rem;
  }
  .route { flex-wrap: wrap; }
  .loc { max-width: 100%; white-space: normal; }
  .row-meta { justify-content: space-between; }
  .bucket-hint { display: none; }
}
</style>
