<template>
  <!-- The dashboard's Driver Performance tab, for a Super Admin: each driver's week as his own Past
       Performance tab shows it, this week's drivers off the board with the reason, and the board by
       unit as /driver shows it to a Super Admin. Display only: nothing here writes, every figure and
       the order are the server's, and each opening reads afresh. -->
  <div class="adp" data-testid="adp">
    <section class="adp-section" aria-labelledby="adp-weeks-title">
      <h3 id="adp-weeks-title" class="adp-heading" data-testid="adp-weeks-title">{{ WORDS.weeksTitle }}</h3>
      <p v-if="state === 'loading'" class="adp-note" data-testid="adp-loading">{{ WORDS.loading }}</p>
      <div v-else-if="!view" class="adp-failed" role="alert" data-testid="adp-failed">
        <p class="adp-note">{{ WORDS.failed }}</p>
        <button type="button" class="adp-retry" data-testid="adp-retry" @click="load">{{ WORDS.retry }}</button>
      </div>
      <template v-else>
        <p v-if="view.weekLine" class="adp-range" data-testid="adp-week-line">{{ view.weekLine }}</p>
        <p class="adp-note" data-testid="adp-target">{{ WORDS.target }}</p>
        <ul v-if="view.rows.length" class="adp-drivers" data-testid="adp-drivers">
          <li v-for="row in view.rows" :key="row.key" class="adp-driver" :data-open="open[row.key] ? 'true' : 'false'" data-testid="adp-driver">
            <button type="button" class="adp-head" :aria-expanded="open[row.key] ? 'true' : 'false'" data-testid="adp-toggle" @click="toggle(row.key)">
              <span class="adp-who">
                <span class="adp-name" data-testid="adp-name">{{ row.name }}</span>
                <span class="adp-unit" data-testid="adp-unit">{{ row.unit }}</span>
              </span>
              <span class="adp-this">
                <span class="adp-label">{{ WORDS.thisWeek }}</span>
                <span class="adp-count-line">
                  <span class="adp-count" data-testid="adp-count">{{ row.count }}</span>
                  <span v-if="row.pace" class="adp-pace" :data-pace="row.paceId" data-testid="adp-pace">{{ row.pace }}</span>
                </span>
                <span class="adp-track" aria-hidden="true">
                  <span class="adp-fill" data-testid="adp-fill" :data-color="row.color || null" :style="{ width: row.width }"></span>
                </span>
                <span class="adp-left" data-testid="adp-left">{{ row.left }}</span>
              </span>
              <span class="adp-last">
                <span class="adp-label">{{ WORDS.lastWeek }}</span>
                <span class="adp-count" data-testid="adp-last-count">{{ row.lastCount }}</span>
              </span>
              <span class="adp-chevron" aria-hidden="true">&#9662;</span>
            </button>
            <div v-if="open[row.key]" class="adp-detail" data-testid="adp-detail">
              <section class="adp-part" :aria-label="row.thisWeek.title" data-testid="adp-this-week">
                <h4 class="adp-part-title" data-testid="adp-this-title">{{ row.thisWeek.title }}</h4>
                <ul v-if="row.thisWeek.loads.length" class="adp-loads">
                  <li v-for="(item, i) in row.thisWeek.loads" :key="i" class="adp-load" data-testid="adp-this-load">
                    <span class="adp-load-id">{{ item.title }}</span>
                    <span class="adp-load-line">{{ item.line }}</span>
                  </li>
                </ul>
                <p v-else class="adp-note" data-testid="adp-this-empty">{{ row.thisWeek.empty }}</p>
                <p v-if="row.thisWeek.newWeek" class="adp-note" data-testid="adp-new-week">{{ row.thisWeek.newWeek }}</p>
                <p class="adp-note" data-testid="adp-rule">{{ row.thisWeek.rule }}</p>
                <p v-if="row.thisWeek.lowered" class="adp-note" data-testid="adp-lowered">{{ row.thisWeek.lowered }}</p>
                <p class="adp-note" data-testid="adp-requirement">{{ row.thisWeek.requirement }}</p>
                <p class="adp-note" data-testid="adp-hours">{{ WORDS.driveHours }}</p>
              </section>
              <section class="adp-part" :aria-label="row.lastWeek.title" data-testid="adp-last-week">
                <h4 class="adp-part-title" data-testid="adp-last-title">{{ row.lastWeek.title }}</h4>
                <ul v-if="row.lastWeek.loads.length" class="adp-loads">
                  <li v-for="(item, i) in row.lastWeek.loads" :key="i" class="adp-load" data-testid="adp-last-load">
                    <span class="adp-load-id">{{ item.title }}</span>
                    <span class="adp-load-line">{{ item.line }}</span>
                  </li>
                </ul>
                <p v-else class="adp-note" data-testid="adp-last-empty">{{ row.lastWeek.empty }}</p>
              </section>
              <section class="adp-part" :aria-label="row.past.title" data-testid="adp-past">
                <h4 class="adp-part-title" data-testid="adp-past-title">{{ row.past.title }}</h4>
                <ul v-if="row.past.rows.length" class="adp-weeks">
                  <li v-for="week in row.past.rows" :key="week.key" class="adp-week" data-testid="adp-past-week">
                    <span class="adp-week-range" data-testid="adp-past-range">{{ week.range }}</span>
                    <span class="adp-week-count" data-testid="adp-past-count">{{ week.count }}</span>
                    <span class="adp-week-hours" data-testid="adp-past-hours">{{ week.hours }}</span>
                  </li>
                </ul>
                <p class="adp-note" data-testid="adp-counted-from">{{ row.past.countedFrom }}</p>
              </section>
            </div>
          </li>
        </ul>
        <p v-else class="adp-note" data-testid="adp-no-drivers">{{ WORDS.noDrivers }}</p>
        <details v-if="view.notOnBoard.length" class="adp-off" data-testid="adp-not-on-board">
          <summary class="adp-off-title" data-testid="adp-not-on-board-title">{{ WORDS.notOnBoardTitle }}</summary>
          <ul class="adp-off-list">
            <li v-for="(item, i) in view.notOnBoard" :key="i" class="adp-off-row" data-testid="adp-off-row">
              <span class="adp-off-name" data-testid="adp-off-name">{{ item.name }}</span>
              <span class="adp-off-reason" data-testid="adp-off-reason">{{ item.reason }}</span>
            </li>
          </ul>
        </details>
      </template>
    </section>

    <section class="adp-section" aria-labelledby="adp-board-title">
      <h3 id="adp-board-title" class="adp-heading" data-testid="adp-board-title">{{ WORDS.boardTitle }}</h3>
      <DriverPerformanceBoard @gone="emit('gone')" />
    </section>
  </div>
</template>

<script setup>
import { computed, onUnmounted, reactive, ref, watch } from 'vue'
import { useApi } from '../../composables/useApi'
import { isGoneAnswer } from '../../lib/driverPerformance'
import { ADMIN_WEEKS_URL, WORDS, driversView } from '../../lib/driverPerformanceAdmin'
import DriverPerformanceBoard from '../driver/DriverPerformanceBoard.vue'

const props = defineProps({ active: { type: Boolean, default: true } })
// The server says this viewer has no tab any more (the switch went off, or the role changed).
const emit = defineEmits(['gone'])

const api = useApi()
let alive = true
onUnmounted(() => { alive = false })

const state = ref('idle')
// Here only, never a store or the browser's storage.
const answer = ref(null)
// Which drivers' rows are open, by directory id.
const open = reactive({})
// Only the newest read lands, so a slow older one never overwrites it.
let latest = null

async function load() {
  const mine = {}
  latest = mine
  state.value = 'loading'
  try {
    const read = await api.get(ADMIN_WEEKS_URL)
    if (!alive || latest !== mine) return
    answer.value = read
    state.value = 'ready'
  } catch (err) {
    if (!alive || latest !== mine) return
    answer.value = null
    state.value = 'failed'
    if (isGoneAnswer(err.status)) emit('gone')
  }
}

function toggle(key) {
  open[key] = !open[key]
}

const view = computed(() => driversView(answer.value))

watch(() => props.active, (shown) => { if (shown) load() }, { immediate: true })
</script>

<style scoped>
.adp {
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
  padding: 1.25rem;
  min-width: 0;
}
.adp-section {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
  min-width: 0;
}
.adp-heading {
  margin: 0;
  font-size: 1rem;
  font-weight: 800;
  color: #111827;
}
.adp-range {
  margin: 0;
  font-size: 0.82rem;
  font-weight: 700;
  color: #374151;
}
.adp-note {
  margin: 0;
  font-size: 0.82rem;
  line-height: 1.45;
  color: #6b7280;
}
.adp-drivers {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  margin: 0;
  padding: 0;
  list-style: none;
}
.adp-driver {
  border: 1px solid #e5e7eb;
  border-radius: 10px;
  background: #fff;
  min-width: 0;
  overflow: hidden;
}
/* One card on a phone: name and chevron, then this week, then last week. One row from md up. */
.adp-head {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 1.25rem;
  grid-template-areas: 'who chevron' 'this this' 'last last';
  gap: 0.5rem 1rem;
  width: 100%;
  min-height: 44px;
  padding: 0.75rem 1rem;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.adp-head:focus-visible {
  outline: 2px solid #0369a1;
  outline-offset: -2px;
}
@media (min-width: 768px) {
  .adp-head {
    grid-template-columns: minmax(10rem, 1.2fr) minmax(14rem, 2fr) minmax(8rem, 1fr) 1.25rem;
    grid-template-areas: 'who this last chevron';
    align-items: center;
  }
}
.adp-who {
  grid-area: who;
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
  min-width: 0;
}
.adp-name {
  font-size: 0.95rem;
  font-weight: 700;
  color: #111827;
  overflow-wrap: anywhere;
}
.adp-unit {
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.75rem;
  color: #6b7280;
  overflow-wrap: anywhere;
}
.adp-this {
  grid-area: this;
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  min-width: 0;
}
.adp-last {
  grid-area: last;
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  min-width: 0;
}
.adp-label {
  font-size: 0.7rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.02em;
  color: #9ca3af;
}
.adp-count-line {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.35rem 0.6rem;
}
.adp-count {
  font-size: 0.92rem;
  font-weight: 700;
  color: #111827;
  white-space: nowrap;
}
/* The pace word on a pale chip, as the driver's own screen shows it. */
.adp-pace {
  padding: 0.1rem 0.55rem;
  border-radius: 999px;
  font-size: 0.75rem;
  font-weight: 700;
  white-space: nowrap;
}
.adp-pace[data-pace='ahead'] { background: #dcfce7; color: #166534; }
.adp-pace[data-pace='on-track'] { background: #e0f2fe; color: #0c4a6e; }
.adp-pace[data-pace='needs-focus'] { background: #e5e7eb; color: #374151; }
.adp-track {
  display: block;
  height: 8px;
  border-radius: 999px;
  background: #e5e7eb;
  overflow: hidden;
}
.adp-fill {
  display: block;
  height: 100%;
  border-radius: 999px;
  background: #0369a1;
}
/* The Loads bar's colors, the server's choice for the week's credits. */
.adp-fill[data-color='red'] { background: #dc2626; }
.adp-fill[data-color='orange'] { background: #ea580c; }
.adp-fill[data-color='green'] { background: #16a34a; }
.adp-fill[data-color='blue'] { background: #2563eb; }
.adp-left {
  font-size: 0.8rem;
  color: #374151;
}
.adp-chevron {
  grid-area: chevron;
  justify-self: end;
  align-self: start;
  font-size: 0.9rem;
  color: #6b7280;
}
@media (min-width: 768px) {
  .adp-chevron { align-self: center; }
}
.adp-driver[data-open='true'] .adp-chevron { transform: rotate(180deg); }
.adp-detail {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 1rem;
  padding: 0.25rem 1rem 1rem;
  border-top: 1px solid #f3f4f6;
}
@media (min-width: 1024px) {
  .adp-detail { grid-template-columns: repeat(3, minmax(0, 1fr)); }
}
.adp-part {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  min-width: 0;
  padding-top: 0.75rem;
}
.adp-part-title {
  margin: 0;
  font-size: 0.85rem;
  font-weight: 800;
  color: #111827;
}
.adp-loads,
.adp-weeks,
.adp-off-list {
  margin: 0;
  padding: 0;
  list-style: none;
}
.adp-load {
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
  padding: 0.4rem 0;
  border-top: 1px solid #f3f4f6;
  min-width: 0;
}
.adp-load:first-child { border-top: none; }
.adp-load-id {
  font-size: 0.85rem;
  font-weight: 700;
  color: #111827;
  overflow-wrap: anywhere;
}
.adp-load-line {
  font-size: 0.8rem;
  color: #6b7280;
  overflow-wrap: anywhere;
}
/* One past week: its days and its figure on a line, its hours under them. */
.adp-week {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 0.1rem 0.75rem;
  padding: 0.45rem 0;
  border-top: 1px solid #f3f4f6;
}
.adp-week:first-child { border-top: none; }
.adp-week-range,
.adp-week-count {
  font-size: 0.85rem;
  font-weight: 700;
  color: #111827;
}
.adp-week-count {
  text-align: right;
  white-space: nowrap;
}
.adp-week-hours {
  grid-column: 1 / -1;
  font-size: 0.8rem;
  color: #6b7280;
}
.adp-off {
  border: 1px solid #e5e7eb;
  border-radius: 10px;
  background: #fff;
}
.adp-off-title {
  min-height: 44px;
  box-sizing: border-box;
  padding: 0.75rem 1rem;
  line-height: 1.4;
  font-size: 0.9rem;
  font-weight: 700;
  color: #111827;
  cursor: pointer;
}
.adp-off-list {
  padding: 0 1rem 0.5rem;
}
.adp-off-row {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 0.25rem 1rem;
  padding: 0.5rem 0;
  border-top: 1px solid #f3f4f6;
  font-size: 0.85rem;
}
.adp-off-name {
  font-weight: 700;
  color: #111827;
  overflow-wrap: anywhere;
}
.adp-off-reason {
  color: #6b7280;
}
.adp-failed {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 0.5rem;
}
.adp-retry {
  min-height: 44px;
  padding: 0 1rem;
  border: 1px solid #0369a1;
  border-radius: 8px;
  background: transparent;
  color: #0369a1;
  font: inherit;
  font-size: 0.85rem;
  font-weight: 700;
  cursor: pointer;
}
</style>
