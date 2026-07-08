<template>
  <!-- Root v-if is defensive: the parent also v-if-removes this card on 'unavailable'. -->
  <section v-if="!unavailable" class="insights-card" aria-labelledby="ai-insights-title">
    <div class="insights-head">
      <h3 id="ai-insights-title" class="insights-title">
        <span class="insights-spark" aria-hidden="true">&#10024;</span>
        AI Insights
      </h3>
      <button
        type="button"
        class="refresh-btn"
        :disabled="loading"
        aria-label="Refresh insights"
        title="Refresh insights"
        @click="fetchInsights"
      >
        <span class="refresh-glyph" :class="{ spinning: loading }" aria-hidden="true">&#8635;</span>
      </button>
    </div>

    <div class="insights-body" aria-live="polite" :aria-busy="loading ? 'true' : 'false'">
      <!-- Loading: app shimmer-skeleton rows (pattern mirrors ExpensesTab .skeleton) -->
      <template v-if="loading">
        <div v-for="n in 3" :key="n" class="skeleton skeleton-row"></div>
      </template>

      <template v-else>
        <p v-if="rateLimited" class="insights-note">
          Rate limit reached &mdash; insights will refresh again in a few minutes.
        </p>
        <p v-else-if="failed" class="insights-error" role="alert">
          Couldn&rsquo;t generate insights &mdash;
          <button type="button" class="retry-link" @click="fetchInsights">retry</button>
        </p>

        <!-- On a refresh error the previous insights stay visible below the note. -->
        <template v-if="hasLoaded">
          <p v-if="!insights.length && !failed && !rateLimited" class="insights-note">
            No insights yet &mdash; log a few more expenses and check back.
          </p>

          <!-- Plain-text interpolation only; AI output is never rendered as raw HTML. -->
          <ul v-if="insights.length" class="insights-list">
            <li v-for="(ins, i) in insights" :key="i" class="insight-row">
              <span class="sev-pill" :class="'sev-' + severityOf(ins)">{{ severityOf(ins) }}</span>
              <div class="insight-text">
                <div class="insight-title">{{ ins.title }}</div>
                <div class="insight-detail">{{ ins.detail }}</div>
              </div>
            </li>
          </ul>

          <div v-if="insights.length" class="insights-caption">
            AI-generated from your expense data<template v-if="updatedLabel"> &middot; {{ updatedLabel }}</template>
          </div>
        </template>
      </template>
    </div>
  </section>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import { useApi } from '../../../composables/useApi'
// Shared dev fixture (shape mirrors the frozen GET /api/expenses/ai/insights 200
// contract: { insights: [{ title<=80, detail<=240, severity }], generatedAt, cached }).
import { INSIGHTS_FIXTURE } from './fixtures'

// ============================================================================
// !!! DEV FIXTURES FLAG — INTEGRATION MUST FLIP THIS TO false !!!
// While true, this card never hits the network: it resolves the canned
// INSIGHTS_FIXTURE from ./fixtures.js so the UI is reviewable before the
// backend lands. At integration, set USE_FIXTURES = false — no other change
// is needed; the fixture import can stay for future dev/testing.
// ============================================================================
const USE_FIXTURES = false

const props = defineProps({
  active: { type: Boolean, default: false },
})

const emit = defineEmits(['unavailable'])

const api = useApi()

const loading = ref(false)
const failed = ref(false)
const rateLimited = ref(false)
const unavailable = ref(false)
const hasLoaded = ref(false)
const data = ref(null)

// Contract says up to 5; clamp defensively so a longer payload can't blow up the card.
const insights = computed(() => ((data.value && data.value.insights) || []).slice(0, 5))

const updatedLabel = computed(() => {
  if (!data.value) return ''
  if (!data.value.cached) return 'Updated just now'
  const gen = data.value.generatedAt ? new Date(data.value.generatedAt) : null
  if (gen && !Number.isNaN(gen.getTime()) && gen.toDateString() !== new Date().toDateString()) {
    return `Updated ${gen.toLocaleDateString()}`
  }
  return 'Updated earlier today'
})

const SEVERITIES = ['info', 'good', 'warn']
function severityOf(ins) {
  return SEVERITIES.includes(ins && ins.severity) ? ins.severity : 'info'
}

// Fixture-mode fetch: the first call renders the "Updated just now" caption;
// refreshes exercise the cached → "Updated earlier today" path.
let fixtureCalls = 0
function fakeInsights() {
  const cached = fixtureCalls++ > 0
  return new Promise((resolve) =>
    setTimeout(() => resolve({ ...INSIGHTS_FIXTURE, generatedAt: new Date().toISOString(), cached }), 500)
  )
}

async function fetchInsights() {
  if (loading.value) return
  loading.value = true
  failed.value = false
  rateLimited.value = false
  try {
    data.value = USE_FIXTURES ? await fakeInsights() : await api.get('/api/expenses/ai/insights')
    hasLoaded.value = true
  } catch (err) {
    if (err.status === 503) {
      unavailable.value = true
      emit('unavailable')
    } else if (err.status === 429) {
      rateLimited.value = true
    } else {
      failed.value = true
    }
  } finally {
    loading.value = false
  }
}

// Lazy first load: fetch once, the first time the parent shows this card.
// (A failed/rate-limited first attempt leaves hasLoaded false, so re-activating
// the tab retries naturally; the refresh button covers everything else.)
watch(
  () => props.active,
  (isActive) => {
    if (isActive && !hasLoaded.value && !loading.value && !unavailable.value) fetchInsights()
  },
  { immediate: true }
)
</script>

<style scoped>
/* Card shell matches ExpensesTab .section-card / AiQueryPanel .ai-card */
.insights-card {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 1rem;
  margin-bottom: 1rem;
}

.insights-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  margin-bottom: 0.75rem;
}

.insights-title {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.82rem;
  font-weight: 700;
  margin: 0;
}

.insights-spark { font-size: 0.85rem; }

.refresh-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 999px;
  color: var(--text-dim);
  cursor: pointer;
  transition: all 0.15s;
  flex-shrink: 0;
}

.refresh-btn:hover:not(:disabled) {
  background: var(--accent-dim);
  border-color: var(--accent);
  color: var(--accent);
}

.refresh-btn:disabled { opacity: 0.5; cursor: not-allowed; }

.refresh-glyph { font-size: 0.85rem; line-height: 1; }

.refresh-glyph.spinning {
  animation: insights-spin 0.9s linear infinite;
}

@keyframes insights-spin { to { transform: rotate(360deg); } }

/* Skeleton (pattern mirrors ExpensesTab .skeleton shimmer) */
.skeleton {
  background: linear-gradient(90deg, var(--surface) 25%, var(--surface-hover) 50%, var(--surface) 75%);
  background-size: 200% 100%;
  animation: insights-shimmer 1.5s infinite;
  border-radius: var(--radius);
}

.skeleton-row { height: 44px; margin-bottom: 0.5rem; }
.skeleton-row:last-child { margin-bottom: 0; }

@keyframes insights-shimmer {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}

/* Insight rows */
.insights-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
}

.insight-row {
  display: flex;
  align-items: flex-start;
  gap: 0.6rem;
  padding: 0.55rem 0;
  border-bottom: 1px solid var(--border);
}

.insight-row:first-child { padding-top: 0; }
.insight-row:last-child { border-bottom: none; padding-bottom: 0; }

/* Severity pills — same recipe as ExpensesTab .type-pill / .status-pill */
.sev-pill {
  display: inline-flex;
  padding: 0.12rem 0.5rem;
  border-radius: 10px;
  font-size: 0.66rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  flex-shrink: 0;
  margin-top: 0.1rem;
}

.sev-warn { background: var(--amber-dim); color: var(--amber); }
.sev-good { background: rgba(16, 185, 129, 0.15); color: #059669; }
.sev-info { background: var(--surface-hover); color: var(--text-dim); }

.insight-text { min-width: 0; }

.insight-title {
  font-size: 0.8rem;
  font-weight: 600;
  line-height: 1.35;
}

.insight-detail {
  font-size: 0.74rem;
  color: var(--text-dim);
  line-height: 1.45;
  margin-top: 0.15rem;
}

/* Notes / errors / caption */
.insights-note {
  font-size: 0.78rem;
  color: var(--text-dim);
  margin: 0 0 0.5rem;
}

.insights-error {
  font-size: 0.8rem;
  color: var(--danger);
  margin: 0 0 0.5rem;
}

.retry-link {
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

.insights-caption {
  font-size: 0.68rem;
  color: var(--text-dim);
  margin-top: 0.6rem;
}
</style>
