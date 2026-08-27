<template>
  <MetricInfoDialog
    :open="open"
    :title="title"
    :subtitle="subtitle"
    @update:open="(v) => { if (!v) $emit('close') }"
  >
    <div v-if="loading" class="md-state">Loading the days behind this figure…</div>
    <div v-else-if="error" class="md-state md-error">{{ error }}</div>
    <template v-else-if="detail">
      <!-- Summary strip. Shows what the range totals BEFORE the itemisation, so
           the reader can check the parts against the whole rather than take the
           headline on trust. -->
      <div class="md-summary">
        <div class="md-sum">
          <span class="md-sum-label">Miles</span>
          <span class="md-sum-val">{{ fmtNum(detail.totals.miles) }}</span>
        </div>
        <div class="md-sum">
          <span class="md-sum-label">Days moved</span>
          <span class="md-sum-val">{{ detail.totals.movingDays }} / {{ detail.totals.days }}</span>
        </div>
        <div class="md-sum">
          <span class="md-sum-label">Diesel</span>
          <span class="md-sum-val">{{ fmtMoney(detail.totals.fuelSpend) }}</span>
        </div>
        <div class="md-sum">
          <span class="md-sum-label" title="Diesel spend divided by miles driven in this range. Fuel only — it is not the all-in cost of running the truck.">Fuel $/mi</span>
          <span class="md-sum-val">{{ fmtCpm(detail.totals.fuelCostPerMile) }}</span>
        </div>
      </div>

      <div v-if="!detail.days.length" class="md-state">
        No ELD days recorded in this range — this truck reported nothing, which is
        not the same as it not moving.
      </div>

      <div v-else class="md-scroll">
        <!-- LEVEL 1: the days. LEVEL 2 expands inline rather than opening a
             second dialog — stacking modals loses the context you clicked from. -->
        <div v-for="d in detail.days" :key="d.localDay + d.driver" class="md-day">
          <button
            class="md-day-head"
            :class="{ open: expanded === d.localDay, idle: d.miles === 0 }"
            :aria-expanded="expanded === d.localDay"
            @click="expanded = expanded === d.localDay ? '' : d.localDay"
          >
            <span class="md-chev" :class="{ open: expanded === d.localDay }" aria-hidden="true">›</span>
            <span class="md-day-name">{{ dayLabel(d.localDay) }}</span>
            <span class="md-day-miles">{{ fmtNum(d.miles) }} mi</span>
            <span v-if="d.basis !== 'eld'" class="md-badge">{{ d.basis === 'partial' ? 'partly seen' : 'no data' }}</span>
            <span v-else-if="d.miles === 0" class="md-badge md-idle">idle</span>
          </button>

          <div v-if="expanded === d.localDay" class="md-day-body">
            <!-- Why the number is what it is. This is the actual question a
                 click is asking. -->
            <div class="md-kv">
              <span>Reported</span>
              <strong>{{ timeRange(d) }}</strong>
            </div>
            <div class="md-kv">
              <span>ELD pings</span>
              <strong>{{ fmtNum(d.samples) }}</strong>
            </div>
            <div v-if="d.driver" class="md-kv">
              <span>Driver</span>
              <strong>{{ d.driver }}</strong>
            </div>

            <div v-if="d.coverageNote" class="md-note">
              <strong>Why this day is marked “partly seen”:</strong> {{ d.coverageNote }}.
              The real distance is higher than shown.
            </div>

            <div class="md-sub">Fuel bought</div>
            <div v-if="!d.fuel.length" class="md-none">No fuel receipts filed on this day.</div>
            <table v-else class="md-table">
              <tbody>
                <tr v-for="(f, i) in d.fuel" :key="i">
                  <td>{{ f.vendor || 'Unknown vendor' }}</td>
                  <td class="num">{{ f.gallons === null ? '—' : f.gallons.toFixed(1) + ' gal' }}</td>
                  <td class="num">{{ fmtMoney(f.amount) }}</td>
                </tr>
              </tbody>
              <tfoot>
                <tr>
                  <td>Total</td>
                  <td class="num">{{ d.fuelGallons === null ? '—' : d.fuelGallons.toFixed(1) + ' gal' }}</td>
                  <td class="num">{{ fmtMoney(d.fuelSpend) }}</td>
                </tr>
              </tfoot>
            </table>
            <div v-if="d.fuel.some(f => f.gallons === null)" class="md-none">
              A receipt here has no gallons recorded, so the volume is an
              under-count. The dollar figure is complete.
            </div>

            <div class="md-sub">Loads worked</div>
            <div v-if="!d.loads.length" class="md-none">No load activity recorded for this driver on this day.</div>
            <ul v-else class="md-loads">
              <li v-for="l in d.loads" :key="l.loadId">
                <span class="md-load-id">{{ l.loadId }}</span>
                <span class="md-load-status">{{ l.statuses.join(' → ') }}</span>
                <span v-if="l.pickup || l.dropoff" class="md-load-route">{{ shortRoute(l) }}</span>
              </li>
            </ul>
          </div>
        </div>
      </div>

      <!-- The contract: the days above must add up to the figure that was
           clicked. If they ever disagree, the drill-down is lying and it should
           be obvious, not hidden. -->
      <div class="md-total">
        <span>{{ detail.days.length }} day{{ detail.days.length === 1 ? '' : 's' }} shown</span>
        <strong>{{ fmtNum(dayMilesSum) }} mi</strong>
      </div>
      <div v-if="dayMilesSum !== detail.totals.miles" class="md-note md-warn">
        These days sum to {{ fmtNum(dayMilesSum) }} mi but the range reports
        {{ fmtNum(detail.totals.miles) }} mi. That is a bug — please report it.
      </div>
    </template>
  </MetricInfoDialog>
</template>

<script setup>
import { ref, computed, watch } from 'vue'
import MetricInfoDialog from '../investor/MetricInfoDialog.vue'

const props = defineProps({
  open: { type: Boolean, default: false },
  title: { type: String, default: '' },
  subtitle: { type: String, default: '' },
  detail: { type: Object, default: null },
  loading: { type: Boolean, default: false },
  error: { type: String, default: '' },
})
defineEmits(['close'])

const expanded = ref('')
// Re-opening on a different cell must not inherit the previous expansion.
watch(() => props.detail, () => { expanded.value = '' })

const dayMilesSum = computed(() =>
  (props.detail?.days || []).reduce((a, d) => a + (Number(d.miles) || 0), 0)
)

function fmtNum(v) { return v === null || v === undefined ? '—' : Number(v).toLocaleString('en-US') }
function fmtMoney(v) { return v === null || v === undefined ? '—' : '$' + Number(v).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 }) }
function fmtCpm(v) { return v === null || v === undefined ? '—' : '$' + Number(v).toFixed(2) }

function dayLabel(day) {
  // Parsed at midday so the label cannot slip a day in a negative-offset zone.
  const d = new Date(String(day) + 'T12:00:00Z')
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })
}
function hhmm(iso) {
  if (!iso) return null
  const d = new Date(iso)
  return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'America/Chicago' })
}
function timeRange(d) {
  const a = hhmm(d.firstAt), b = hhmm(d.lastAt)
  if (!a || !b) return 'no readings'
  return `${a} – ${b}` + (d.activeHours != null ? ` (${d.activeHours}h)` : '')
}
function shortRoute(l) {
  const city = (s) => String(s || '').split(',').slice(0, 1).join('').trim()
  const a = city(l.pickup), b = city(l.dropoff)
  if (!a && !b) return ''
  return `${a || '?'} → ${b || '?'}`
}
</script>

<style scoped>
.md-state { padding: 1rem 0.75rem; color: var(--text-dim, #6b7085); font-size: 0.82rem; }
.md-error { color: var(--danger, #b91c1c); }

.md-summary {
  display: grid; grid-template-columns: repeat(4, 1fr); gap: 0.4rem;
  padding: 0.5rem 0.75rem 0.65rem;
}
.md-sum { display: flex; flex-direction: column; gap: 0.1rem; }
.md-sum-label { font-size: 0.62rem; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-dim, #94a3b8); }
.md-sum-val { font-size: 0.95rem; font-weight: 800; font-variant-numeric: tabular-nums; }

.md-scroll { max-height: 320px; overflow-y: auto; padding: 0 0.25rem; }

.md-day + .md-day { border-top: 1px solid var(--border-soft, #eef0f4); }
.md-day-head {
  width: 100%; display: flex; align-items: center; gap: 0.5rem;
  background: transparent; border: 0; cursor: pointer; text-align: left;
  padding: 0.42rem 0.5rem; font-size: 0.8rem; color: inherit;
}
.md-day-head:hover { background: var(--bg, #f8fafc); border-radius: 6px; }
.md-day-head.idle .md-day-miles { color: var(--text-dim, #94a3b8); }
.md-chev { display: inline-block; transition: transform .15s ease; color: var(--text-dim, #94a3b8); }
.md-chev.open { transform: rotate(90deg); }
.md-day-name { font-weight: 600; }
.md-day-miles { margin-left: auto; font-variant-numeric: tabular-nums; font-weight: 700; }
.md-badge {
  font-size: 0.6rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.03em;
  background: #fef3c7; color: #92400e; padding: 0.05rem 0.35rem; border-radius: 999px;
}
.md-badge.md-idle { background: #e5e7eb; color: #4b5563; }

.md-day-body { padding: 0.25rem 0.75rem 0.7rem 1.4rem; }
.md-kv { display: flex; justify-content: space-between; font-size: 0.76rem; padding: 0.12rem 0; color: var(--text-dim, #6b7085); }
.md-kv strong { color: var(--text, #1f2937); font-variant-numeric: tabular-nums; }

.md-note {
  margin: 0.4rem 0; padding: 0.45rem 0.6rem; border-radius: 6px;
  background: #fffbeb; border: 1px solid #fde68a; color: #78350f;
  font-size: 0.73rem; line-height: 1.45;
}
.md-note.md-warn { background: #fef2f2; border-color: #fecaca; color: #991b1b; }

.md-sub {
  margin: 0.55rem 0 0.2rem; font-size: 0.63rem; font-weight: 700;
  text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-dim, #94a3b8);
}
.md-none { font-size: 0.73rem; color: var(--text-dim, #94a3b8); font-style: italic; }

.md-table { width: 100%; border-collapse: collapse; font-size: 0.74rem; }
.md-table td { padding: 0.16rem 0; }
.md-table .num { text-align: right; font-variant-numeric: tabular-nums; }
.md-table tfoot td { border-top: 1px solid var(--border-soft, #eef0f4); font-weight: 700; padding-top: 0.24rem; }

.md-loads { list-style: none; margin: 0; padding: 0; }
.md-loads li { display: flex; align-items: baseline; gap: 0.45rem; font-size: 0.74rem; padding: 0.12rem 0; flex-wrap: wrap; }
.md-load-id { font-weight: 700; font-variant-numeric: tabular-nums; }
.md-load-status { color: var(--text-dim, #6b7085); }
.md-load-route { color: var(--text-dim, #94a3b8); font-size: 0.7rem; }

.md-total {
  display: flex; justify-content: space-between; align-items: baseline;
  padding: 0.5rem 0.75rem; margin-top: 0.35rem;
  border-top: 1px solid var(--border, #d8dbe3);
  font-size: 0.8rem; color: var(--text-dim, #6b7085);
}
.md-total strong { font-size: 0.95rem; color: var(--text, #1f2937); font-variant-numeric: tabular-nums; }

@media (max-width: 520px) {
  .md-summary { grid-template-columns: repeat(2, 1fr); }
}
</style>
