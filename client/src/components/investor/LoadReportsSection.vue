<!--
  LoadReportsSection — weekly & monthly load reports + totals owed for the
  investor portal. Fetches GET /api/investor/load-report (per-period load lists +
  gross revenue). Broker identity is never shown. "Your Share" is the authoritative
  NET investor earnings from the dashboard's monthlyEarnings (passed in via
  :production): the monthly total, and per completed load its rate-weighted slice
  of that month's net — so every figure reconciles with EarningsSection / the rest
  of the portal. Weekly has no monthly-net mapping, so it shows loads + gross only.
  Exports pass the same net back as ?net=YYYY-MM:amount so the PDF/CSV reconcile too.
  "Owed to date" is the cumulative investorNetToDate. Honors Super-Admin "view as
  investor" through the :preview-user-id prop (threaded as ?as_user_id=).
-->
<template>
  <div class="lr-section">
    <div class="lr-head">
      <h2 class="lr-title">Load Reports</h2>
      <div class="lr-toggle">
        <button :class="['lr-tab', { active: period === 'monthly' }]" @click="setPeriod('monthly')">Monthly</button>
        <button :class="['lr-tab', { active: period === 'weekly' }]" @click="setPeriod('weekly')">Weekly</button>
      </div>
    </div>

    <div class="lr-owed">
      <span class="lr-owed-label">Total owed to date <span class="lr-sub">(earned, before payouts)</span></span>
      <span class="lr-owed-value">{{ fmtMoney(owedToDate) }}</span>
    </div>

    <div v-if="loading" class="lr-msg">Loading load reports…</div>
    <div v-else-if="error" class="lr-msg">Couldn’t load load reports.</div>
    <div v-else-if="!periods.length" class="lr-msg">No loads found for this {{ period }} view yet.</div>
    <template v-else>
      <div class="lr-nav">
        <button class="lr-navbtn" :disabled="selectedIdx >= periods.length - 1" @click="selectedIdx++">‹ Older</button>
        <select v-model.number="selectedIdx" class="lr-select">
          <option v-for="(p, i) in periods" :key="p.key" :value="i">{{ p.label }}</option>
        </select>
        <button class="lr-navbtn" :disabled="selectedIdx <= 0" @click="selectedIdx--">Newer ›</button>
        <div class="lr-export">
          <button class="lr-exp" @click="exportReport('csv')">Export CSV</button>
          <button class="lr-exp" @click="exportReport('pdf')">Export PDF</button>
        </div>
      </div>

      <div class="lr-cards" v-if="sel">
        <div class="lr-card">
          <div class="lr-card-label">Loads</div>
          <div class="lr-card-value">{{ sel.loadCount }}</div>
        </div>
        <div class="lr-card">
          <div class="lr-card-label">Gross Revenue</div>
          <div class="lr-card-value">{{ fmtMoney(sel.grossRevenue) }}</div>
        </div>
        <div class="lr-card" v-if="monthlyNet != null">
          <div class="lr-card-label">Your Share (net)</div>
          <div class="lr-card-value accent">{{ fmtMoney(monthlyNet) }}</div>
        </div>
      </div>

      <p v-if="period === 'weekly'" class="lr-note">
        Net investor share is reconciled monthly — switch to Monthly to see your share.
      </p>

      <div class="lr-table-wrap" v-if="sel">
        <table class="lr-table">
          <thead>
            <tr>
              <th>Load</th><th>Status</th><th>Route</th>
              <th class="num">Rate</th><th class="num">Your Share</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="l in sel.loads" :key="l.loadId">
              <td class="mono">{{ l.loadId }}</td>
              <td><span class="lr-badge">{{ l.status || '—' }}</span></td>
              <td class="lr-route">{{ l.pickup || '—' }} → {{ l.dropoff || '—' }}</td>
              <td class="num">{{ l.rate ? fmtMoney(l.rate) : '—' }}</td>
              <td class="num">{{ shareOf(l) == null ? '—' : fmtMoney(shareOf(l)) }}</td>
            </tr>
            <tr v-if="!sel.loads.length"><td colspan="5" class="lr-empty">No loads in this period.</td></tr>
          </tbody>
        </table>
      </div>
    </template>
  </div>
</template>

<script setup>
import { ref, computed, watch } from 'vue'
import { useApi } from '../../composables/useApi'
import { useToast } from '../../composables/useToast'

const props = defineProps({
  production: { type: Object, default: () => ({}) },
  config: { type: Object, default: () => ({}) },
  previewUserId: { default: null },
})

const api = useApi()
const { show: toast } = useToast()

const period = ref('monthly')
const periods = ref([])
const selectedIdx = ref(0)
const loading = ref(false)
const error = ref(false)

const owedToDate = computed(() => props.production?.investorNetToDate || 0)
const sel = computed(() => periods.value[selectedIdx.value] || null)
// Authoritative monthly net share, reused from the dashboard's monthlyEarnings
// so this section reconciles with EarningsSection / the rest of the portal.
const monthlyNet = computed(() => {
  if (period.value !== 'monthly' || !sel.value) return null
  const m = (props.production?.monthlyEarnings || []).find((x) => x.month === sel.value.key)
  return m ? (m.investorEarnings || 0) : null
})

// Allocate the month's authoritative net investor earnings (monthlyNet) across
// its completed loads, rate-weighted, as whole dollars that sum EXACTLY to
// monthlyNet (largest-remainder) so the rows reconcile with the "Your Share
// (net)" card above. {} when there's no monthly net (e.g. the weekly view) —
// never a gross-based estimate. Mirrors allocateNet() in server.js — keep in sync.
function allocateNet(loads, net) {
  const out = {}
  if (net == null) return out
  const done = (loads || []).filter((l) => l.completed && (l.rate || 0) > 0)
  const denom = done.reduce((s, l) => s + l.rate, 0)
  if (denom <= 0) return out
  const target = Math.round(net)
  let allocated = 0
  const rema = []
  for (const l of done) {
    const exact = (target * l.rate) / denom
    const base = Math.floor(exact)
    out[l.loadId] = base
    allocated += base
    rema.push({ id: l.loadId, f: exact - base })
  }
  let leftover = target - allocated
  rema.sort((a, b) => b.f - a.f)
  for (let i = 0; i < rema.length && leftover > 0; i++, leftover--) out[rema[i].id] += 1
  return out
}
const shareMap = computed(() => allocateNet(sel.value?.loads, monthlyNet.value))
function shareOf(l) {
  if (!l) return null
  return Object.prototype.hasOwnProperty.call(shareMap.value, l.loadId) ? shareMap.value[l.loadId] : null
}

// Authoritative net per month from the dashboard, handed to the export so the
// PDF/CSV reconcile with the portal. Server matches by YYYY-MM; weekly ignores it.
function netParam() {
  return (props.production?.monthlyEarnings || [])
    .filter((m) => m && m.month)
    .map((m) => `${m.month}:${Math.round(m.investorEarnings || 0)}`)
    .join(',')
}

function previewParams(extra) {
  const params = new URLSearchParams(extra || {})
  if (props.previewUserId != null) params.set('as_user_id', String(props.previewUserId))
  return params
}

async function fetchReport() {
  loading.value = true
  error.value = false
  try {
    const qs = previewParams({ period: period.value }).toString()
    const r = await api.get(`/api/investor/load-report?${qs}`)
    periods.value = Array.isArray(r.periods) ? r.periods : []
    selectedIdx.value = 0
  } catch {
    error.value = true
    periods.value = []
  } finally {
    loading.value = false
  }
}

function setPeriod(p) {
  if (p !== period.value) {
    period.value = p
    fetchReport()
  }
}
watch(() => props.previewUserId, fetchReport)

async function exportReport(format) {
  try {
    const extra = { period: period.value, format }
    const net = netParam()
    if (net) extra.net = net
    const qs = previewParams(extra).toString()
    const res = await fetch(`/api/investor/load-report?${qs}`, { credentials: 'include' })
    if (!res.ok) throw new Error('Failed')
    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    const cd = res.headers.get('Content-Disposition') || ''
    const match = cd.match(/filename="(.+)"/)
    a.download = match ? match[1] : `load-report.${format}`
    a.click()
    URL.revokeObjectURL(url)
  } catch {
    toast('Failed to export report', 'error')
  }
}

function fmtMoney(n) {
  const v = Math.round(Number(n) || 0)
  return (v < 0 ? '-$' : '$') + Math.abs(v).toLocaleString()
}

fetchReport()
</script>

<style scoped>
.lr-section {
  background: #fff;
  border: 1px solid #e2e8f0;
  border-radius: 14px;
  padding: 1.1rem 1.25rem;
  margin-bottom: 1rem;
}
.lr-head { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; flex-wrap: wrap; }
.lr-title { font-size: 1.05rem; font-weight: 700; color: #0f172a; margin: 0; }
.lr-toggle { display: inline-flex; background: #f1f5f9; border-radius: 999px; padding: 3px; }
.lr-tab { border: none; background: transparent; padding: 5px 14px; border-radius: 999px; font-size: 0.82rem; font-weight: 600; color: #64748b; cursor: pointer; }
.lr-tab.active { background: #fff; color: #0f172a; box-shadow: 0 1px 2px rgba(0,0,0,0.08); }

.lr-owed { display: flex; align-items: baseline; justify-content: space-between; gap: 0.5rem; margin: 0.9rem 0 0.4rem; padding: 0.7rem 0.9rem; background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 10px; }
.lr-owed-label { font-size: 0.82rem; font-weight: 600; color: #166534; }
.lr-sub { font-weight: 400; color: #4d7c5a; }
.lr-owed-value { font-size: 1.35rem; font-weight: 800; color: #15803d; }

.lr-msg { color: #64748b; font-size: 0.88rem; padding: 0.8rem 0; }

.lr-nav { display: flex; align-items: center; gap: 0.5rem; margin: 0.7rem 0; flex-wrap: wrap; }
.lr-navbtn { border: 1px solid #e2e8f0; background: #fff; border-radius: 8px; padding: 5px 10px; font-size: 0.8rem; cursor: pointer; color: #334155; }
.lr-navbtn:disabled { opacity: 0.4; cursor: not-allowed; }
.lr-select { border: 1px solid #e2e8f0; border-radius: 8px; padding: 5px 8px; font-size: 0.82rem; color: #0f172a; background: #fff; }
.lr-export { margin-left: auto; display: flex; gap: 0.4rem; }
.lr-exp { border: 1px solid #cbd5e1; background: #f8fafc; border-radius: 8px; padding: 5px 12px; font-size: 0.8rem; font-weight: 600; color: #334155; cursor: pointer; }
.lr-exp:hover { background: #f1f5f9; }

.lr-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 0.6rem; margin: 0.5rem 0; }
.lr-card { background: #f8fafc; border: 1px solid #eef2f7; border-radius: 10px; padding: 0.6rem 0.8rem; }
.lr-card-label { font-size: 0.7rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.02em; color: #94a3b8; }
.lr-card-value { font-size: 1.2rem; font-weight: 700; color: #0f172a; margin-top: 2px; }
.lr-card-value.accent { color: #15803d; }
.lr-note { font-size: 0.74rem; color: #94a3b8; margin: 0.1rem 0 0.5rem; }

.lr-table-wrap { overflow-x: auto; margin-top: 0.4rem; }
.lr-table { width: 100%; border-collapse: collapse; font-size: 0.82rem; }
.lr-table th { text-align: left; font-size: 0.68rem; text-transform: uppercase; letter-spacing: 0.02em; color: #94a3b8; padding: 0.4rem 0.5rem; border-bottom: 1px solid #e2e8f0; white-space: nowrap; }
.lr-table td { padding: 0.45rem 0.5rem; border-bottom: 1px solid #f1f5f9; color: #334155; vertical-align: top; }
.lr-table .num { text-align: right; white-space: nowrap; }
.lr-table .mono { font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 0.78rem; }
.lr-route { color: #475569; }
.lr-badge { display: inline-block; padding: 1px 7px; border-radius: 999px; background: #eef2ff; color: #4338ca; font-size: 0.7rem; font-weight: 600; }
.lr-empty { text-align: center; color: #94a3b8; padding: 0.8rem; }
</style>
