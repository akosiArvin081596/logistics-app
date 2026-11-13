<template>
  <!-- A Super Admin's before-payroll check, read only. Every day, line, reason and figure is the
       server's (GET /api/admin/payroll-check); lib/payrollCheck.js names them and shows cents as dollars. -->
  <div v-if="visible" ref="rootEl" class="payroll-check-page admin-page" style="overflow-y:auto;min-height:auto;flex:none;" data-testid="pc-page">
    <div class="page-header pc-header">
      <div class="pc-heading">
        <h2>{{ WORDS.title }}</h2>
        <p class="pc-desc">{{ WORDS.intro }}</p>
      </div>
      <router-link :to="{ name: 'invoices' }" class="pc-back">{{ WORDS.back }}</router-link>
    </div>

    <p v-if="state === 'off'" class="pc-line" role="status" data-testid="pc-off">{{ WORDS.off }}</p>
    <template v-else>
      <div class="pc-controls">
        <label class="pc-week">
          <span class="pc-week-label">{{ WORDS.week }}</span>
          <select class="pc-select" :value="weekEnd" data-testid="pc-week" @change="pickWeek($event.target.value)">
            <option v-for="w in weeks" :key="w.value" :value="w.value">{{ w.label }}</option>
          </select>
        </label>
        <button type="button" class="pc-button" :disabled="state === 'loading'" data-testid="pc-again" @click="load">{{ WORDS.again }}</button>
      </div>

      <p v-if="state === 'loading'" class="pc-line" role="status" data-testid="pc-loading">{{ WORDS.loading }}</p>
      <p v-else-if="state === 'refused'" class="pc-line pc-problem" role="alert" data-testid="pc-refused">{{ problem }}</p>
      <div v-else-if="state === 'retry' || state === 'failed'" class="pc-line pc-problem pc-problem-row" role="alert" :data-testid="state === 'retry' ? 'pc-retry' : 'pc-failed'">
        <span>{{ problem }}</span>
        <button type="button" class="pc-button" data-testid="pc-try-again" @click="load">{{ WORDS.retry }}</button>
      </div>

      <template v-else-if="state === 'ready' && view">
        <div class="pc-scope" data-testid="pc-scope">
          <p class="pc-week-text">{{ view.weekText }}</p>
          <p class="pc-desc">{{ view.scopeText }}</p>
          <p v-if="view.generatedText" class="pc-desc">{{ WORDS.checkedAt }} {{ view.generatedText }}</p>
        </div>
        <p v-if="view.clear" class="pc-line pc-clear" role="status" data-testid="pc-clear">{{ WORDS.allClear }}</p>

        <section class="pc-section" aria-labelledby="pc-totals-title">
          <h3 id="pc-totals-title" class="pc-title">{{ WORDS.totals }}</h3>
          <ul class="pc-totals">
            <li v-for="t in view.totals" :key="t.key" class="pc-total" data-testid="pc-total" :data-key="t.key">
              <span class="pc-total-title">{{ t.title }}</span>
              <span class="pc-total-figures">
                <strong data-testid="pc-total-count">{{ t.count }}</strong>
                <span class="pc-dot" aria-hidden="true">·</span>
                <span class="pc-money" data-testid="pc-total-amount">{{ t.amount }}</span>
              </span>
              <span v-if="t.byReason.length" class="pc-total-reasons">
                <span v-for="r in t.byReason" :key="r.code" class="pc-reason-count">{{ r.tag }}: {{ r.count }}</span>
              </span>
            </li>
          </ul>
        </section>

        <section v-for="s in view.sections" :key="s.key" class="pc-section" :data-section="s.key" :aria-labelledby="`pc-${s.key}-title`">
          <h3 :id="`pc-${s.key}-title`" class="pc-title">{{ s.title }}</h3>
          <p class="pc-desc">{{ s.note }}</p>
          <div v-for="part in s.parts" :key="part.key" class="pc-part" :data-part="part.key">
            <h4 v-if="s.parts.length > 1" class="pc-subtitle">{{ part.title }}</h4>
            <p v-if="!part.groups.length" class="pc-empty" data-testid="pc-empty">{{ WORDS.empty }}</p>
            <!-- A phone, or a page too narrow for the columns: one card per item, every field labelled. -->
            <div v-else-if="showCards" class="pc-cards">
              <div v-for="g in part.groups" :key="g.key" class="pc-card-group">
                <p class="pc-group-title" data-testid="pc-group">{{ g.label }}</p>
                <div v-for="r in g.rows" :key="r.key" class="pc-card" data-testid="pc-card">
                  <dl class="pc-fields">
                    <div v-for="c in part.columns" :key="c.key" class="pc-field">
                      <dt>{{ c.label }}</dt>
                      <dd :class="{ 'pc-money': c.key === 'amount' }" :data-cell="c.key">{{ r.cells[c.key] }}</dd>
                    </div>
                  </dl>
                  <p v-if="part.reasons" class="pc-card-why">
                    <span class="pc-tag" data-testid="pc-tag">{{ r.tag }}</span>
                    <span class="pc-why" data-testid="pc-why">{{ r.text }}</span>
                  </p>
                </div>
              </div>
            </div>
            <table v-else class="pc-table">
              <thead>
                <tr>
                  <th v-for="c in part.columns" :key="c.key" scope="col" :class="`pc-col-${c.key}`">{{ c.label }}</th>
                  <th v-if="part.reasons" scope="col" class="pc-col-why">{{ WORDS.why }}</th>
                </tr>
              </thead>
              <tbody v-for="g in part.groups" :key="g.key">
                <tr class="pc-group-row">
                  <th :colspan="part.reasons ? part.columns.length + 1 : part.columns.length" scope="colgroup" class="pc-group-title" data-testid="pc-group">{{ g.label }}</th>
                </tr>
                <tr v-for="r in g.rows" :key="r.key" class="pc-row" data-testid="pc-row">
                  <td v-for="c in part.columns" :key="c.key" :class="{ 'pc-money': c.key === 'amount' }" :data-cell="c.key">{{ r.cells[c.key] }}</td>
                  <td v-if="part.reasons" class="pc-why-cell">
                    <span class="pc-tag" data-testid="pc-tag">{{ r.tag }}</span>
                    <span class="pc-why" data-testid="pc-why">{{ r.text }}</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <section class="pc-section" aria-labelledby="pc-rollup-title">
          <h3 id="pc-rollup-title" class="pc-title">{{ WORDS.byDriver }}</h3>
          <p v-if="!view.drivers.length" class="pc-empty" data-testid="pc-rollup-empty">{{ WORDS.empty }}</p>
          <div v-else-if="showCards" class="pc-cards">
            <div v-for="r in view.drivers" :key="r.key" class="pc-card" data-testid="pc-rollup-row">
              <p class="pc-group-title">{{ r.driver }} · {{ r.week }}</p>
              <dl class="pc-fields">
                <template v-for="(c, i) in r.cells" :key="c.key">
                  <div v-if="c.count" class="pc-field">
                    <dt>{{ view.rollupColumns[i].label }}</dt>
                    <dd class="pc-money">{{ c.text }}</dd>
                  </div>
                </template>
              </dl>
            </div>
          </div>
          <table v-else class="pc-table pc-rollup">
            <thead>
              <tr>
                <th scope="col" class="pc-col-driver">{{ WORDS.driver }}</th>
                <th scope="col" class="pc-col-week">{{ WORDS.weekColumn }}</th>
                <th v-for="c in view.rollupColumns" :key="c.key" scope="col">{{ c.label }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in view.drivers" :key="r.key" data-testid="pc-rollup-row">
                <td>{{ r.driver }}</td>
                <td>{{ r.week }}</td>
                <td v-for="c in r.cells" :key="c.key" class="pc-money">{{ c.text }}</td>
              </tr>
            </tbody>
          </table>
        </section>
      </template>
    </template>
  </div>
</template>

<script setup>
import { computed, ref } from 'vue'
import { useApi } from '../composables/useApi'
import { useViewport } from '../composables/useViewport'
import { useElementWidth } from '../composables/useElementWidth'
import { useAuthStore } from '../stores/auth'
import { appToday } from '../utils/datetime'
import { notePayrollCheckSwitch } from '../composables/usePayrollCheckSwitch.js'
import { WORDS, canSeePayrollCheck, checkUrl, checkView, errorView, weekOptions } from '../lib/payrollCheck.js'

// Super Admin only (router meta and the route's own gate); for anyone else this renders nothing and
// asks nothing. Its only request is the check's GET, for the week picked.
const api = useApi()
const auth = useAuthStore()
const visible = computed(() => canSeePayrollCheck(auth.user?.role))

// The lists' columns need about 45rem (720 px); on a phone, or beside a sidebar that leaves less, cards.
const CARDS_BELOW = 720
const rootEl = ref(null)
const { isMobile } = useViewport()
const { width } = useElementWidth(rootEl)
const showCards = computed(() => isMobile.value || (width.value > 0 && width.value < CARDS_BELOW))

const weeks = weekOptions(appToday())
const weekEnd = ref(weeks.length ? weeks[0].value : '')
const state = ref('idle')
const problem = ref('')
const answer = ref(null)
const view = computed(() => checkView(answer.value))

// Only the newest read lands, so a slow answer for an earlier week never replaces it.
let latest = null
async function load() {
  if (!visible.value || !weekEnd.value) return
  const mine = {}
  latest = mine
  state.value = 'loading'
  try {
    const read = await api.get(checkUrl(weekEnd.value))
    if (latest !== mine) return
    notePayrollCheckSwitch(true)
    answer.value = read
    state.value = view.value ? 'ready' : 'failed'
    problem.value = view.value ? '' : WORDS.failed
  } catch (err) {
    if (latest !== mine) return
    const shown = errorView(err)
    if (shown.kind === 'off') notePayrollCheckSwitch(false)
    answer.value = null
    state.value = shown.kind
    problem.value = shown.text
  }
}

function pickWeek(value) {
  weekEnd.value = value
  load()
}

load()
</script>

<style scoped>
.pc-header { align-items: flex-start; }
.pc-heading { min-width: 0; }
.pc-desc {
  margin: 0.25rem 0 0;
  font-size: 0.82rem;
  color: var(--text-dim);
  overflow-wrap: anywhere;
}
.pc-back {
  font-size: 0.82rem;
  font-weight: 600;
  color: var(--accent);
  text-decoration: none;
}
.pc-back:hover, .pc-back:focus-visible { text-decoration: underline; }

.pc-controls { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 0.6rem; margin-bottom: 1rem; }
.pc-week { display: flex; flex-direction: column; gap: 0.25rem; min-width: 0; max-width: 100%; }
.pc-week-label { font-size: 0.75rem; font-weight: 600; color: var(--text-dim); }
.pc-select {
  height: 2.25rem;
  max-width: 100%;
  padding: 0 0.6rem;
  border: 1px solid #e2e4ea;
  border-radius: 8px;
  background: #fff;
  font-family: inherit;
  font-size: 0.82rem;
  color: #111827;
}
.pc-button {
  height: 2.25rem;
  padding: 0 0.9rem;
  border: 1px solid #e2e4ea;
  border-radius: 8px;
  background: #fff;
  font-family: inherit;
  font-size: 0.8rem;
  font-weight: 600;
  color: #111827;
  cursor: pointer;
}
.pc-button:disabled { opacity: 0.55; cursor: default; }
.pc-button:not(:disabled):hover { background: #f9fafb; }

.pc-line { margin: 0 0 1rem; font-size: 0.85rem; color: var(--text-dim); }
.pc-problem {
  padding: 0.6rem 0.85rem;
  border-radius: var(--radius);
  background: var(--danger-dim);
  color: #b91c1c;
}
.pc-problem-row { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 0.75rem; }
.pc-clear { padding: 0.6rem 0.85rem; border-radius: var(--radius); background: #ecfdf5; color: #047857; }

.pc-scope { margin-bottom: 1rem; min-width: 0; }
.pc-week-text { margin: 0; font-size: 1rem; font-weight: 700; color: #111827; }

.pc-section { display: flex; flex-direction: column; gap: 0.5rem; margin-bottom: 1.5rem; min-width: 0; }
.pc-title { margin: 0; font-size: 1rem; font-weight: 800; color: #111827; }
.pc-subtitle { margin: 0.5rem 0 0; font-size: 0.88rem; font-weight: 700; color: #1f2937; }
.pc-part { display: flex; flex-direction: column; gap: 0.5rem; min-width: 0; }
.pc-empty { margin: 0; font-size: 0.82rem; color: var(--text-dim); font-style: italic; }

.pc-totals {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 14rem), 1fr));
  gap: 0.6rem;
}
.pc-total {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  min-width: 0;
  padding: 0.7rem 0.85rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
}
.pc-total-title { font-size: 0.75rem; font-weight: 600; color: var(--text-dim); }
.pc-total-figures { font-size: 1rem; color: #111827; }
.pc-dot { margin: 0 0.3rem; color: var(--text-dim); }
.pc-total-reasons { display: flex; flex-wrap: wrap; gap: 0.25rem 0.6rem; font-size: 0.72rem; color: #475569; }
.pc-money { font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 0.78rem; overflow-wrap: anywhere; }
.pc-total-figures .pc-money { font-size: 0.95rem; }

.pc-table { width: 100%; table-layout: fixed; border-collapse: collapse; font-size: 0.8rem; }
.pc-table th {
  text-align: left;
  font-size: 0.7rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-dim);
  padding: 0.5rem;
  border-bottom: 1px solid var(--border);
  overflow-wrap: anywhere;
}
.pc-table td { padding: 0.5rem; border-bottom: 1px solid var(--border); vertical-align: top; overflow-wrap: anywhere; }
.pc-table th.pc-col-day, .pc-table th.pc-col-date, .pc-table th.pc-col-completed { width: 7.5rem; }
.pc-table th.pc-col-load { width: 7rem; }
.pc-table th.pc-col-invoice { width: 12rem; }
.pc-table th.pc-col-amount { width: 8rem; }
.pc-table th.pc-col-vendor, .pc-table th.pc-col-corrects { width: 11rem; }
.pc-table th.pc-col-type, .pc-table th.pc-col-status, .pc-table th.pc-col-kind { width: 7.5rem; }
.pc-table th.pc-col-driver { width: 9rem; }
.pc-table th.pc-col-week { width: 10rem; }
.pc-table .pc-group-row th {
  padding-top: 0.75rem;
  text-transform: none;
  letter-spacing: 0;
  font-size: 0.8rem;
  font-weight: 700;
  color: #111827;
  background: #f8fafc;
}
.pc-tag {
  display: inline-block;
  margin: 0 0.4rem 0.2rem 0;
  padding: 0.05rem 0.45rem;
  border-radius: 0.6rem;
  background: #fef3c7;
  color: #92400e;
  font-size: 0.7rem;
  font-weight: 600;
  line-height: 1.4;
}
.pc-why { color: #374151; }

.pc-cards { display: flex; flex-direction: column; gap: 0.6rem; }
.pc-card-group { display: flex; flex-direction: column; gap: 0.5rem; }
.pc-group-title { margin: 0.25rem 0 0; font-size: 0.82rem; font-weight: 700; color: #111827; overflow-wrap: anywhere; }
.pc-card {
  min-width: 0;
  padding: 0.75rem 0.9rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
}
.pc-fields { margin: 0; display: flex; flex-direction: column; gap: 0.3rem; }
.pc-field { display: grid; grid-template-columns: 7rem minmax(0, 1fr); gap: 0.5rem; font-size: 0.8rem; }
.pc-field dt { color: var(--text-dim); font-weight: 600; }
.pc-field dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
.pc-card-why { margin: 0.5rem 0 0; font-size: 0.8rem; overflow-wrap: anywhere; }
</style>
