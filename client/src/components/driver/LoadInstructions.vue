<!--
  The load's instructions from the rate con, on the driver's load page (plan PR 4).
  Display only: the server sends the published payload already filtered for drivers
  and ordered (critical requirements first), plus its highlight codes; this card shows
  each item once, in that order, as plain text. Directions and warehouse notes sit
  behind "More from the rate con" per stop. Unpublished: one grey line saying dispatch
  is checking them. No card without the payload's `_instructions` key (the server's
  flag off), on a 404 or on a 403. Logic: lib/loadInstructions.js.
-->
<template>
  <section
    v-if="view.kind !== 'hidden'"
    class="load-instructions"
    :class="{ 'li-compact': view.kind !== 'card' }"
    aria-label="Load instructions"
    data-testid="load-instructions"
  >
    <p v-if="view.kind === 'checking'" class="li-line" role="status" data-testid="li-checking">{{ CHECKING_TEXT }}</p>
    <p v-else-if="view.kind === 'loading'" class="li-line" role="status">{{ LOADING_TEXT }}</p>
    <div v-else-if="view.kind === 'error'" class="li-line li-error" role="alert">
      <span>{{ ERROR_TEXT }}</span>
      <button type="button" class="li-retry" @click="retry">Try again</button>
    </div>
    <template v-else>
      <h3 class="li-title">{{ CARD_TITLE }}</h3>
      <ul v-if="chips.length" class="li-chips" aria-label="Critical requirements" data-testid="li-chips">
        <li v-for="c in chips" :key="c.code" class="li-chip">{{ c.label }}</li>
      </ul>
      <ul v-if="loadRequirements.length" class="li-reqs">
        <li v-for="(r, i) in loadRequirements" :key="`lr-${i}`" class="li-req" :class="{ critical: r.critical }">
          <span v-if="r.critical" class="li-bang" aria-hidden="true">!</span>
          <span><span v-if="r.critical" class="li-sr">Important. </span><span class="li-cat">{{ categoryLabel(r.category) }}:</span> {{ r.text }}</span>
        </li>
      </ul>
      <div v-for="({ stop, parts }, si) in stopViews" :key="`stop-${si}`" class="li-stop" data-testid="li-stop">
        <h4 class="li-stop-title">
          Stop {{ stop.seq || si + 1 }} · {{ stopKindLabel(stop.kind) }}<template v-if="stop.facility"> · {{ stop.facility }}</template><span v-if="stop.place" class="li-place">, {{ stop.place }}</span>
        </h4>
        <dl v-if="parts.references.length" class="li-refs">
          <div v-for="(ref, ri) in parts.references" :key="`ref-${si}-${ri}`" class="li-ref">
            <dt class="li-ref-label">{{ referenceLabel(ref) }}</dt>
            <dd class="li-ref-row">
              <span class="li-ref-value" data-testid="li-ref-value">{{ ref.value }}</span>
              <button
                type="button"
                class="li-copy"
                :aria-label="`Copy ${referenceLabel(ref)} ${ref.value}`"
                @click="copy(ref.value, `${si}-${ri}`)"
              >{{ copied === `${si}-${ri}` ? 'Copied' : 'Copy' }}</button>
            </dd>
          </div>
        </dl>
        <ul v-if="parts.requirements.length" class="li-reqs">
          <li v-for="(r, ri) in parts.requirements" :key="`req-${si}-${ri}`" class="li-req" :class="{ critical: r.critical }">
            <span v-if="r.critical" class="li-bang" aria-hidden="true">!</span>
            <span><span v-if="r.critical" class="li-sr">Important. </span><span class="li-cat">{{ categoryLabel(r.category) }}:</span> {{ r.text }}</span>
          </li>
        </ul>
        <ul v-if="parts.instructions.length" class="li-notes">
          <li v-for="(x, xi) in parts.instructions" :key="`ins-${si}-${xi}`" class="li-note">
            <span class="li-cat">{{ instructionKindLabel(x.kind) }}:</span> {{ x.text }}
          </li>
        </ul>
        <details v-if="parts.more.length" class="li-more">
          <summary>{{ MORE_LABEL }}</summary>
          <ul class="li-notes">
            <li v-for="(x, xi) in parts.more" :key="`more-${si}-${xi}`" class="li-note">
              <span class="li-cat">{{ instructionKindLabel(x.kind) }}:</span> {{ x.text }}
            </li>
          </ul>
        </details>
      </div>
      <p class="li-foot">{{ payload.footnote }}</p>
      <p v-if="view.stale" class="li-line li-error" role="status">
        <span>{{ STALE_TEXT }}</span>
        <button type="button" class="li-retry" @click="retry">Try again</button>
      </p>
      <span class="li-sr" aria-live="polite">{{ copied ? 'Copied' : '' }}</span>
    </template>
  </section>
</template>

<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useDriverStore } from '../../stores/driver'
import { categoryLabel, instructionKindLabel, referenceLabel, stopKindLabel } from '../../lib/driverInstructionsView'
import {
  CARD_TITLE, CHECKING_TEXT, ERROR_TEXT, LOADING_TEXT, MORE_LABEL, STALE_TEXT,
  cardView, chipsOf, instructionsKey, shouldFetch, stopParts,
} from '../../lib/loadInstructions'

const props = defineProps({
  loadId: { type: String, default: '' },
  // The load's `_instructions` from GET /api/driver/:driverName: { state, highlights }.
  summary: { type: Object, default: null },
})

const driverStore = useDriverStore()
const list = (v) => (Array.isArray(v) ? v : [])

const entry = computed(() => driverStore.instructions[instructionsKey(props.loadId)])
const view = computed(() => cardView(props.summary, entry.value))
const answer = computed(() => entry.value?.answer || null)
const payload = computed(() => answer.value?.payload || { loadRequirements: [], stops: [], footnote: '' })
const chips = computed(() => chipsOf(answer.value?.highlights))
const loadRequirements = computed(() => list(payload.value.loadRequirements))
const stopViews = computed(() => list(payload.value.stops).map((stop) => ({ stop, parts: stopParts(stop) })))

// Read when the load opens, and again when the list says the server has something
// new for it (the socket's re-read goes through DriverView).
watch(() => [props.loadId, props.summary?.state], () => {
  if (shouldFetch(props.summary)) driverStore.fetchLoadInstructions(props.loadId)
}, { immediate: true })

function retry() {
  driverStore.fetchLoadInstructions(props.loadId)
}

// Drivers give these numbers at the gate: one tap copies one.
const copied = ref('')
let copiedTimer = null
async function copy(value, key) {
  try {
    await navigator.clipboard.writeText(value)
  } catch {
    return
  }
  copied.value = key
  clearTimeout(copiedTimer)
  copiedTimer = setTimeout(() => { copied.value = '' }, 1500)
}
onBeforeUnmount(() => clearTimeout(copiedTimer))
</script>

<style scoped>
.load-instructions {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 0.75rem;
  margin-bottom: 0.75rem;
}
.load-instructions.li-compact {
  background: var(--bg);
  border-color: transparent;
  padding: 0.6rem 0.75rem;
}
.li-title {
  margin: 0 0 0.5rem;
  font-size: 0.95rem;
  font-weight: 700;
  color: var(--text);
}
.li-line {
  margin: 0;
  font-size: 0.85rem;
  color: var(--text-dim);
}
.li-error {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
}
.li-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
  list-style: none;
  margin: 0 0 0.6rem;
  padding: 0;
}
.li-chip {
  padding: 0.2rem 0.6rem;
  border-radius: 999px;
  border: 1px solid rgba(239, 68, 68, 0.35);
  background: var(--danger-dim);
  color: #b91c1c;
  font-size: 0.72rem;
  font-weight: 700;
  letter-spacing: 0.03em;
  text-transform: uppercase;
}
.li-reqs,
.li-notes {
  display: grid;
  gap: 0.35rem;
  list-style: none;
  margin: 0 0 0.5rem;
  padding: 0;
}
.li-req,
.li-note {
  font-size: 0.88rem;
  line-height: 1.4;
  color: var(--text);
  overflow-wrap: anywhere;
}
.li-req {
  display: flex;
  gap: 0.4rem;
}
.li-req.critical {
  color: #991b1b;
  font-weight: 600;
}
.li-bang {
  flex: 0 0 1.25rem;
  height: 1.25rem;
  margin-top: 0.05rem;
  border-radius: 50%;
  background: var(--danger);
  color: #fff;
  font-size: 0.8rem;
  font-weight: 800;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.li-cat {
  font-weight: 700;
}
.li-stop {
  border-top: 1px solid var(--border);
  margin-top: 0.6rem;
  padding-top: 0.6rem;
}
.li-stop-title {
  margin: 0 0 0.4rem;
  font-size: 0.88rem;
  font-weight: 700;
  color: var(--text);
  overflow-wrap: anywhere;
}
.li-place {
  font-weight: 500;
  color: var(--text-dim);
}
.li-refs {
  display: grid;
  gap: 0.35rem;
  margin: 0 0 0.5rem;
}
/* One label width for every row, so the numbers line up; a longer label wraps. */
.li-ref {
  display: grid;
  grid-template-columns: 6.5rem minmax(0, 1fr);
  gap: 0.5rem;
  align-items: center;
}
.li-ref-label {
  font-size: 0.78rem;
  font-weight: 600;
  color: var(--text-dim);
  overflow-wrap: anywhere;
}
.li-ref-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  min-width: 0;
  margin: 0;
}
.li-ref-value {
  flex: 1;
  min-width: 0;
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.92rem;
  font-weight: 600;
  color: var(--text);
  overflow-wrap: anywhere;
  word-break: break-all;
}
.li-copy {
  flex: 0 0 auto;
  min-height: 44px;
  min-width: 64px;
  padding: 0 0.75rem;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg);
  color: var(--text);
  font-size: 0.8rem;
  font-weight: 600;
}
.li-copy:active {
  border-color: var(--accent);
}
.li-more > summary {
  min-height: 44px;
  display: flex;
  align-items: center;
  cursor: pointer;
  font-size: 0.82rem;
  font-weight: 600;
  color: var(--text-dim);
}
.li-foot {
  margin: 0.6rem 0 0;
  font-size: 0.75rem;
  font-style: italic;
  color: var(--text-dim);
}
.li-retry {
  flex: 0 0 auto;
  min-height: 44px;
  padding: 0 0.75rem;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  color: var(--text);
  font-size: 0.8rem;
  font-weight: 600;
}
.li-sr {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}
</style>
