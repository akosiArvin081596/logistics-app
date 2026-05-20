<template>
  <div class="section-card">
    <button
      type="button"
      class="section-header-row section-toggle"
      :aria-expanded="expanded"
      aria-controls="my-loads-body"
      @click="expanded = !expanded"
    >
      <span class="section-title-wrap">
        <svg
          class="chevron"
          :class="{ 'chevron-open': expanded }"
          width="14" height="14" viewBox="0 0 24 24"
          fill="none" stroke="currentColor" stroke-width="2.5"
          stroke-linecap="round" stroke-linejoin="round"
        ><polyline points="9 18 15 12 9 6"/></svg>
        <h3 class="section-title">My Loads</h3>
      </span>
      <span class="header-meta">
        <span
          class="pill-summary pill-amber clickable-pill"
          role="button" tabindex="0"
          title="Click for explanation of pending loads"
          @click.stop="openDetail('pendingLoads')"
          @keyup.enter.stop="openDetail('pendingLoads')"
          @keyup.space.stop.prevent="openDetail('pendingLoads')"
        >
          <strong>{{ pending.length }}</strong> pending
        </span>
        <span
          class="pill-summary pill-green clickable-pill"
          role="button" tabindex="0"
          title="Click for explanation of active loads"
          @click.stop="openDetail('activeLoads')"
          @keyup.enter.stop="openDetail('activeLoads')"
          @keyup.space.stop.prevent="openDetail('activeLoads')"
        >
          <strong>{{ active.length }}</strong> active
        </span>
      </span>
    </button>

    <div v-show="expanded" id="my-loads-body" class="section-body">
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
            <span
              class="share mono clickable-share"
              role="button" tabindex="0"
              :title="`Your share at ${splitPct}% split — click for the math`"
              @click="openLoadShare(l)"
              @keyup.enter="openLoadShare(l)"
              @keyup.space.prevent="openLoadShare(l)"
            >{{ fmtMoney(l.yourShare) }}</span>
            <button
              v-if="l.loadId"
              type="button"
              class="track-btn"
              :class="{ 'track-btn-copied': copiedLoadId === l.loadId }"
              :title="copiedLoadId === l.loadId ? 'Copied!' : 'Copy public tracking link to share with customer'"
              @click="copyTrackingLink(l.loadId)"
            >
              <svg v-if="copiedLoadId !== l.loadId" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
              <svg v-else width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
              {{ copiedLoadId === l.loadId ? 'Copied' : 'Track' }}
            </button>
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
            <span
              class="share mono clickable-share"
              role="button" tabindex="0"
              :title="`Your share at ${splitPct}% split — click for the math`"
              @click="openLoadShare(l)"
              @keyup.enter="openLoadShare(l)"
              @keyup.space.prevent="openLoadShare(l)"
            >{{ fmtMoney(l.yourShare) }}</span>
            <button
              v-if="l.loadId"
              type="button"
              class="track-btn"
              :class="{ 'track-btn-copied': copiedLoadId === l.loadId }"
              :title="copiedLoadId === l.loadId ? 'Copied!' : 'Copy public tracking link to share with customer'"
              @click="copyTrackingLink(l.loadId)"
            >
              <svg v-if="copiedLoadId !== l.loadId" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
              <svg v-else width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
              {{ copiedLoadId === l.loadId ? 'Copied' : 'Track' }}
            </button>
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

    <!-- Detail modal -->
    <MetricInfoDialog
      :open="!!detailType"
      :title="modalTitle"
      :subtitle="modalSubtitle"
      @update:open="v => { if (!v) { detailType = ''; selectedLoad = null } }"
    >
      <!-- Pending Loads -->
      <template v-if="detailType === 'pendingLoads'">
        <div class="modal-breakdown">
          <div class="modal-explain">
            <strong>Pending</strong> loads are loads that have been assigned to one of your trucks but the driver has not yet started picking them up.
          </div>
          <div class="step-label">What This Counts</div>
          <div class="modal-explain-sm">
            Loads in the "Assigned", "Dispatched", or "Heading to Shipper" stage. Once the driver arrives at the shipper, the load moves into the Active bucket.
          </div>
          <template v-if="pending.length">
            <div class="step-label">Current Pending Loads</div>
            <div class="modal-monthly-list">
              <div v-for="l in pending" :key="l.loadId" class="modal-row">
                <span>{{ l.loadId || '—' }}</span>
                <span class="val">{{ l.status || 'Pending' }}</span>
              </div>
            </div>
          </template>
          <div class="modal-divider"></div>
          <div class="modal-row bold result">
            <span>Pending Total</span>
            <span class="val">{{ pending.length }}</span>
          </div>
        </div>
      </template>

      <!-- Active Loads -->
      <template v-if="detailType === 'activeLoads'">
        <div class="modal-breakdown">
          <div class="modal-explain">
            <strong>Active</strong> loads are currently being executed by one of your trucks &mdash; either at the shipper, loading, in transit between shipper and receiver, or unloading at the receiver.
          </div>
          <div class="step-label">Active Stages</div>
          <div class="modal-explain-sm">
            "At Shipper", "Loading", "In Transit", "At Receiver", and "Unloading" all count as active. Once the load is marked Delivered or POD-Received, it leaves this bucket.
          </div>
          <template v-if="active.length">
            <div class="step-label">Current Active Loads</div>
            <div class="modal-monthly-list">
              <div v-for="l in active" :key="l.loadId" class="modal-row">
                <span>{{ l.loadId || '—' }}</span>
                <span class="val">{{ l.status || 'Active' }}</span>
              </div>
            </div>
          </template>
          <div class="modal-divider"></div>
          <div class="modal-row bold result">
            <span>Active Total</span>
            <span class="val">{{ active.length }}</span>
          </div>
        </div>
      </template>

      <!-- Load Share -->
      <template v-if="detailType === 'loadShare' && selectedLoad">
        <div class="modal-breakdown">
          <div class="modal-explain">
            "Your Share" is the estimated portion of the load's gross payment that you'll keep, based on your configured investor split.
          </div>
          <div class="step-label">For Load {{ selectedLoad.loadId }}</div>
          <div class="modal-row">
            <span>Load Gross (estimated)</span>
            <span class="val">{{ fmtMoney(impliedLoadGross(selectedLoad)) }}</span>
          </div>
          <div class="modal-row deduct">
            <span>&times; {{ splitPct }}% (your investor split)</span>
            <span class="val">&nbsp;</span>
          </div>
          <div class="modal-divider"></div>
          <div class="modal-row bold result">
            <span>Your Share</span>
            <span class="val accent">{{ fmtMoney(selectedLoad.yourShare) }}</span>
          </div>
          <div class="modal-callout warning">
            This is an <strong>estimate</strong> &mdash; gross times your split percentage. The final take-home is reconciled in the monthly Earnings Summary after driver pay, fixed costs, and trip expenses are deducted.
          </div>
        </div>
      </template>
    </MetricInfoDialog>
  </div>
</template>

<script setup>
import { computed, ref } from 'vue'
import MetricInfoDialog from './MetricInfoDialog.vue'

const props = defineProps({
  myLoads: { type: Object, default: () => ({ pending: [], active: [] }) },
  config: { type: Object, default: () => ({}) },
})

// Expand by default when the investor actually has loads to look at;
// stay collapsed when there's nothing to show so the dashboard stays
// scannable. User's manual toggle (after mount) is preserved on refresh
// because we don't re-derive this — it's seeded once at setup time.
const expanded = ref(
  (props.myLoads?.pending?.length || 0) + (props.myLoads?.active?.length || 0) > 0
)

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

// --- Detail modal ---
const detailType = ref('')
const selectedLoad = ref(null)
function openDetail(type) {
  detailType.value = type
  selectedLoad.value = null
}
function openLoadShare(load) {
  selectedLoad.value = load
  detailType.value = 'loadShare'
}

const MODAL_CONFIG = {
  pendingLoads: { title: 'Pending Loads', subtitle: 'Loads assigned to your trucks, not yet picked up' },
  activeLoads: { title: 'Active Loads', subtitle: 'Loads your trucks are currently executing' },
  loadShare: { title: 'Your Share for This Load', subtitle: 'How the per-load estimate is computed' },
}

const modalTitle = computed(() => MODAL_CONFIG[detailType.value]?.title || '')
const modalSubtitle = computed(() => MODAL_CONFIG[detailType.value]?.subtitle || '')

function impliedLoadGross(load) {
  if (!load) return 0
  if (load.loadGross) return load.loadGross
  if (load.yourShare && splitPct.value > 0) {
    return Math.round((load.yourShare * 100) / splitPct.value)
  }
  return load.yourShare || 0
}

const copiedLoadId = ref('')
let copiedTimer = null
async function copyTrackingLink(loadId) {
  if (!loadId) return
  const url = `${window.location.origin}/track/${encodeURIComponent(loadId)}`
  try {
    await navigator.clipboard.writeText(url)
    copiedLoadId.value = loadId
    if (copiedTimer) clearTimeout(copiedTimer)
    copiedTimer = setTimeout(() => { copiedLoadId.value = '' }, 1500)
  } catch {
    window.prompt('Copy this tracking link:', url)
  }
}
</script>

<style scoped>
.section-card {
  background: var(--surface); border-radius: var(--radius); border: 1px solid var(--border);
  padding: 1.25rem; margin-bottom: 1.25rem;
}
.section-header-row { display: flex; align-items: center; justify-content: space-between; }
.section-toggle {
  width: 100%; background: transparent; border: none; padding: 0;
  font: inherit; color: inherit; cursor: pointer; text-align: left;
}
.section-toggle:focus-visible {
  outline: 2px solid var(--accent); outline-offset: 4px; border-radius: 6px;
}
.section-title-wrap {
  display: flex; align-items: center; gap: 0.5rem;
}
.section-title { font-size: 1rem; font-weight: 700; margin: 0; }
.chevron {
  color: var(--text-dim);
  transition: transform 0.15s ease;
  flex-shrink: 0;
}
.chevron-open { transform: rotate(90deg); }
.header-meta {
  display: flex; align-items: center; gap: 0.4rem;
}
.pill-summary {
  font-size: 0.7rem; font-weight: 500;
  padding: 0.2rem 0.55rem; border-radius: 99px;
  white-space: nowrap;
}
.pill-summary strong { font-weight: 700; margin-right: 0.15rem; }
.clickable-pill { cursor: pointer; transition: filter 0.15s ease, transform 0.15s ease; }
.clickable-pill:hover { filter: brightness(0.92); transform: translateY(-1px); }
.clickable-pill:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.clickable-share { cursor: pointer; text-decoration-style: dotted; text-underline-offset: 3px; }
.clickable-share:hover { text-decoration: underline; text-decoration-style: dotted; }
.clickable-share:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 3px; }
.section-body { margin-top: 1rem; }
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
.track-btn {
  display: inline-flex; align-items: center; gap: 0.3rem;
  font: inherit; font-size: 0.7rem; font-weight: 600;
  padding: 0.25rem 0.55rem;
  background: var(--bg); color: var(--text-dim);
  border: 1px solid var(--border); border-radius: 6px;
  cursor: pointer; transition: all 0.15s;
  white-space: nowrap;
}
.track-btn:hover { background: var(--surface); color: var(--accent); border-color: var(--accent); }
.track-btn-copied { background: #d1fae5; color: #065f46; border-color: #34d399; }
.track-btn-copied:hover { background: #d1fae5; color: #065f46; }
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
