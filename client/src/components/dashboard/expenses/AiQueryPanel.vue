<template>
  <!-- Root v-if is defensive: the parent also v-if-removes this card on 'unavailable'. -->
  <section v-if="!unavailable" class="ai-card" aria-labelledby="ai-query-title">
    <h3 id="ai-query-title" class="ai-card-title">
      <span class="ai-sparkle" aria-hidden="true">&#10024;</span>
      Ask AI about expenses
    </h3>

    <form class="ask-row" @submit.prevent="ask()">
      <label class="sr-only" for="ai-question-input">Ask a question about your expense data</label>
      <input
        id="ai-question-input"
        v-model="question"
        class="ask-input"
        type="text"
        maxlength="300"
        placeholder="e.g. Which gas station do we frequent the most?"
        autocomplete="off"
        :disabled="loading"
      />
      <button type="submit" class="ask-btn" :disabled="loading || !canAsk">
        <span v-if="loading" class="ask-spinner" aria-hidden="true"></span>
        {{ loading ? 'Asking…' : 'Ask' }}
      </button>
    </form>

    <div class="chips" aria-label="Suggested questions">
      <button
        v-for="s in SUGGESTIONS"
        :key="s"
        type="button"
        class="chip"
        :disabled="loading"
        @click="ask(s)"
      >
        {{ s }}
      </button>
    </div>

    <div class="ai-results" aria-live="polite" :aria-busy="loading ? 'true' : 'false'">
      <div v-if="failed" class="ai-error" role="alert">
        AI had trouble &mdash;
        <button type="button" class="ai-retry" @click="ask(lastQuestion)">try again</button>
      </div>

      <template v-else-if="result">
        <!-- Plain-text interpolation only; AI output is never rendered as raw HTML. -->
        <p class="ai-answer" :class="{ 'ai-answer-muted': result.unsupported }">{{ result.answer }}</p>

        <template v-if="!result.unsupported && result.rows && result.rows.length">
          <div class="table-scroll">
            <table class="ai-table">
              <thead>
                <tr>
                  <th v-for="col in result.columns" :key="col.key" scope="col">{{ col.label }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(row, i) in result.rows" :key="i">
                  <td
                    v-for="col in result.columns"
                    :key="col.key"
                    :class="{ 'cell-num': isNumeric(row[col.key]) }"
                  >
                    {{ formatCell(col, row[col.key]) }}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <!-- Mini-chart per chartHint. Bar: FinancialsView bar-track pattern, single hue. -->
          <div v-if="chartBars.length" class="bar-list">
            <div v-for="bar in chartBars" :key="bar.key" class="bar-row">
              <div class="bar-label">
                <span class="bar-name">{{ bar.label }}</span>
                <span class="bar-val">{{ bar.display }}</span>
              </div>
              <div class="bar-track">
                <div class="bar-fill" :style="{ width: bar.pct + '%' }"></div>
              </div>
            </div>
          </div>
          <svg
            v-else-if="sparkPoints"
            class="sparkline"
            viewBox="0 0 100 28"
            preserveAspectRatio="none"
            role="img"
            :aria-label="`Trend of ${numericCol ? numericCol.label : 'values'}`"
          >
            <polyline :points="sparkPoints" />
          </svg>
        </template>

        <div class="ai-caption">AI-generated from your expense data</div>
      </template>
    </div>

    <details v-if="history.length" class="ai-history">
      <summary>Recent questions ({{ history.length }})</summary>
      <div v-for="(h, i) in history" :key="i" class="hist-item">
        <div class="hist-q">{{ h.question }}</div>
        <div class="hist-a">{{ h.answer }}</div>
      </div>
    </details>
  </section>
</template>

<script setup>
import { computed, ref } from 'vue'
import { useApi } from '../../../composables/useApi'
import { useToast } from '../../../composables/useToast'
// Shared dev fixture (shape mirrors the frozen POST /api/expenses/ai/query 200 contract).
import { AI_QUERY_FIXTURE } from './fixtures'

// ============================================================================
// !!! DEV FIXTURES FLAG — INTEGRATION MUST FLIP THIS TO false !!!
// While true, this panel never hits the network: it resolves the canned
// AI_QUERY_FIXTURE from ./fixtures.js so the UI is reviewable before the
// backend lands. At integration, set USE_FIXTURES = false — no other change
// is needed; the fixture import can stay for future dev/testing.
// ============================================================================
const USE_FIXTURES = false

const emit = defineEmits(['unavailable'])

const api = useApi()
const toast = useToast()

const SUGGESTIONS = [
  'Which gas station do we frequent the most?',
  'Fuel spend in Pacific states this year',
  'Top repair vendors last 90 days',
]

const question = ref('')
const loading = ref(false)
const failed = ref(false)
const unavailable = ref(false)
const result = ref(null)
const lastQuestion = ref('')
// Short session history: the last 3 answered Q&A pairs (previous answers only —
// the current one renders in the answer area above).
const history = ref([])

const canAsk = computed(() => question.value.trim().length >= 3)

function fakeQuery() {
  return new Promise((resolve) => setTimeout(() => resolve({ ...AI_QUERY_FIXTURE }), 450))
}

async function ask(preset) {
  if (preset != null) question.value = preset
  const q = question.value.trim()
  if (q.length < 3 || q.length > 300 || loading.value) return
  loading.value = true
  failed.value = false
  try {
    const data = USE_FIXTURES ? await fakeQuery() : await api.post('/api/expenses/ai/query', { question: q })
    // Roll the previous pair into history before replacing it.
    if (result.value && lastQuestion.value) {
      history.value = [{ question: lastQuestion.value, answer: result.value.answer }, ...history.value].slice(0, 3)
    }
    result.value = data
    lastQuestion.value = q
  } catch (err) {
    if (err.status === 503) {
      unavailable.value = true
      emit('unavailable')
    } else if (err.status === 429) {
      toast.show('AI rate limit reached — try again in a few minutes', 'error')
    } else {
      lastQuestion.value = q
      failed.value = true
    }
  } finally {
    loading.value = false
  }
}

// ---- Cell formatting -------------------------------------------------------
const CURRENCY_RE = /spend|amount|total|cost|price|avg|revenue|pay|charge/i

function isNumeric(v) {
  return v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v))
}

function formatCurrency(n) {
  const whole = Math.abs(n % 1) < 0.005
  return n.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: whole ? 0 : 2,
  })
}

function formatCell(col, value) {
  if (!isNumeric(value)) return value === null || value === undefined || value === '' ? '—' : value
  const n = Number(value)
  if (CURRENCY_RE.test(col.key) || CURRENCY_RE.test(col.label)) return formatCurrency(n)
  return n.toLocaleString()
}

// ---- Mini chart -------------------------------------------------------------
// First numeric column AFTER the label column drives the chart. Column 0 is
// always the group label in this contract — skipping it matters when truck
// units are numeric strings ("101"), which would otherwise win the scan.
const numericCol = computed(() => {
  if (!result.value || result.value.unsupported) return null
  const { columns = [], rows = [] } = result.value
  if (!rows.length) return null
  return columns.slice(1).find((c) => rows.every((r) => isNumeric(r[c.key]))) || null
})

const labelCol = computed(() => {
  if (!result.value || !numericCol.value) return null
  const cols = result.value.columns || []
  return cols.find((c) => c.key !== numericCol.value.key) || null
})

const chartBars = computed(() => {
  if (!result.value || result.value.chartHint !== 'bar' || result.value.unsupported) return []
  const col = numericCol.value
  if (!col) return []
  const rows = (result.value.rows || []).slice(0, 8)
  const max = Math.max(...rows.map((r) => Number(r[col.key])), 0)
  if (max <= 0) return []
  return rows.map((r, i) => ({
    key: i,
    label: labelCol.value ? String(r[labelCol.value.key] ?? '') : `#${i + 1}`,
    display: formatCell(col, r[col.key]),
    pct: Math.max(0, (Number(r[col.key]) / max) * 100),
  }))
})

// 'line' hint: a plain sparkline polyline — the table stays the source of truth.
const sparkPoints = computed(() => {
  if (!result.value || result.value.chartHint !== 'line' || result.value.unsupported) return ''
  const col = numericCol.value
  if (!col) return ''
  const vals = (result.value.rows || []).map((r) => Number(r[col.key])).filter(Number.isFinite)
  if (vals.length < 2) return ''
  const min = Math.min(...vals)
  const span = Math.max(...vals) - min || 1
  return vals
    .map((v, i) => `${((i / (vals.length - 1)) * 100).toFixed(2)},${(26 - ((v - min) / span) * 22).toFixed(2)}`)
    .join(' ')
})
</script>

<style scoped>
/* Card shell matches ExpensesTab .section-card */
.ai-card {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 1rem;
  margin-bottom: 1rem;
}

.ai-card-title {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.82rem;
  font-weight: 700;
  margin-bottom: 0.75rem;
}

.ai-sparkle { font-size: 0.85rem; }

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

/* Input row */
.ask-row {
  display: flex;
  gap: 0.5rem;
}

.ask-input {
  flex: 1;
  min-width: 0;
  padding: 0.45rem 0.6rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  font-family: inherit;
  font-size: 0.8rem;
  background: var(--surface);
  color: var(--text);
  outline: none;
}

.ask-input:focus { border-color: var(--accent); }
.ask-input:disabled { opacity: 0.6; }

.ask-btn {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.45rem 0.85rem;
  border: none;
  border-radius: var(--radius);
  font-family: inherit;
  font-size: 0.8rem;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s;
  white-space: nowrap;
  background: var(--accent);
  color: #fff;
}

.ask-btn:hover:not(:disabled) { opacity: 0.9; }
.ask-btn:disabled { opacity: 0.5; cursor: not-allowed; }

.ask-spinner {
  width: 12px;
  height: 12px;
  border: 2px solid rgba(255, 255, 255, 0.4);
  border-top-color: #fff;
  border-radius: 50%;
  animation: ai-spin 0.7s linear infinite;
  flex-shrink: 0;
}

@keyframes ai-spin { to { transform: rotate(360deg); } }

/* Suggestion chips */
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
  margin-top: 0.6rem;
}

.chip {
  padding: 0.28rem 0.65rem;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 999px;
  font-family: inherit;
  font-size: 0.72rem;
  font-weight: 500;
  color: var(--text-dim);
  cursor: pointer;
  transition: all 0.15s;
}

.chip:hover:not(:disabled) {
  background: var(--accent-dim);
  border-color: var(--accent);
  color: var(--accent);
}

.chip:disabled { opacity: 0.5; cursor: not-allowed; }

/* Results */
.ai-results:not(:empty) { margin-top: 0.85rem; }

.ai-answer {
  font-size: 0.82rem;
  line-height: 1.5;
  margin: 0 0 0.6rem;
}

.ai-answer-muted { color: var(--text-dim); font-style: italic; }

.ai-caption {
  font-size: 0.68rem;
  color: var(--text-dim);
  margin-top: 0.5rem;
}

.ai-error {
  font-size: 0.8rem;
  color: var(--danger);
}

.ai-retry {
  background: none;
  border: none;
  padding: 0;
  font-family: inherit;
  font-size: inherit;
  font-weight: 600;
  color: var(--accent);
  text-decoration: underline;
  cursor: pointer;
}

/* Result table (styles mirror ExpensesTab tables; scrolls sideways on narrow screens) */
.table-scroll {
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  margin-bottom: 0.75rem;
}

.ai-table { width: 100%; border-collapse: collapse; }

.ai-table thead { background: var(--surface-hover); }

.ai-table th {
  padding: 0.55rem 0.75rem;
  text-align: left;
  font-size: 0.68rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-dim);
  border-bottom: 1px solid var(--border);
  white-space: nowrap;
}

.ai-table td {
  padding: 0.5rem 0.75rem;
  font-size: 0.8rem;
  border-bottom: 1px solid var(--border);
  white-space: nowrap;
}

.ai-table tr:last-child td { border-bottom: none; }

.cell-num { font-family: 'JetBrains Mono', monospace; font-size: 0.76rem; }

/* Bar mini-chart — FinancialsView bar-track pattern, single hue, values in text ink */
.bar-list {
  display: flex;
  flex-direction: column;
  gap: 0.55rem;
}

.bar-label {
  display: flex;
  justify-content: space-between;
  gap: 0.75rem;
  font-size: 0.75rem;
  font-weight: 600;
  margin-bottom: 0.25rem;
}

.bar-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.bar-val {
  font-family: 'JetBrains Mono', monospace;
  font-weight: 700;
  color: var(--text);
  flex-shrink: 0;
}

.bar-track {
  height: 8px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 6px;
  overflow: hidden;
}

.bar-fill {
  height: 100%;
  border-radius: 6px;
  background: var(--accent);
  transition: width 0.5s ease;
}

/* Sparkline */
.sparkline {
  width: 100%;
  height: 34px;
  display: block;
}

.sparkline polyline {
  fill: none;
  stroke: var(--accent);
  stroke-width: 1.5;
  vector-effect: non-scaling-stroke;
}

/* Session history */
.ai-history { margin-top: 0.85rem; }

.ai-history summary {
  font-size: 0.72rem;
  font-weight: 600;
  color: var(--text-dim);
  cursor: pointer;
}

.hist-item {
  padding: 0.5rem 0;
  border-bottom: 1px solid var(--border);
}

.hist-item:last-child { border-bottom: none; }

.hist-q { font-size: 0.75rem; font-weight: 600; margin-bottom: 0.15rem; }

.hist-a { font-size: 0.72rem; color: var(--text-dim); line-height: 1.4; }
</style>
