<template>
  <!-- The board by unit on the office's dashboard: the driver board's own views and words, in plain markup,
       since Vant's styles would restyle every office page. Display only; each opening reads afresh. -->
  <div class="adb" data-testid="adb">
    <div class="adb-periods" role="group" data-testid="adb-periods">
      <button v-for="period in BOARD_PERIODS" :key="period.id" type="button" class="adb-period" :aria-pressed="periodId === period.id ? 'true' : 'false'" data-testid="adb-period" @click="periodId = period.id">{{ period.label }}</button>
    </div>

    <p v-if="boardState === 'loading'" class="adb-note" data-testid="adb-loading">{{ WORDS.loading }}</p>
    <div v-else-if="!board" class="adb-failed" role="alert" data-testid="adb-failed">
      <p class="adb-note">{{ WORDS.failed }}</p>
      <button type="button" class="adb-retry" data-testid="adb-retry" @click="loadBoard(kind)">{{ WORDS.retry }}</button>
    </div>
    <template v-else>
      <p class="adb-range" data-testid="adb-range">{{ board.range }}</p>
      <p v-if="board.closes" class="adb-note" data-testid="adb-closes">{{ board.closes }}</p>
      <section v-for="tile in board.tiles" :key="tile.id" class="adb-tile" :data-category="tile.id" data-testid="adb-tile">
        <div class="adb-tile-head">
          <h4 class="adb-tile-title" data-testid="adb-tile-title">{{ tile.title }}</h4>
          <span v-if="tile.comingSoon" class="adb-soon" data-testid="adb-soon">{{ WORDS.comingSoon }}</span>
        </div>
        <p class="adb-note" data-testid="adb-tile-line">{{ tile.line }}</p>
        <ol v-if="tile.rows.length" class="adb-rows">
          <li v-for="(row, i) in tile.rows" :key="i" class="adb-row" data-testid="adb-row">
            <span class="adb-rank">{{ row.rank }}</span>
            <span class="adb-unit" data-testid="adb-unit">{{ row.unit }}</span>
            <span class="adb-figure">{{ row.figure }}</span>
          </li>
        </ol>
        <p v-else-if="!tile.comingSoon" class="adb-note" data-testid="adb-empty">{{ WORDS.boardEmpty }}</p>
      </section>
    </template>

    <!-- Fixed, outside every condition above, as on the driver board. -->
    <p class="adb-hos" role="note" data-testid="adb-hos">{{ WORDS.hos }}</p>
  </div>
</template>

<script setup>
import { computed, onUnmounted, reactive, ref, watch } from 'vue'
import { useApi } from '../../composables/useApi'
import { BOARD_PERIODS, WORDS, boardUrl, boardView, isGoneAnswer, periodKind } from '../../lib/driverPerformanceAdmin'

// The server says this viewer has no board any more (the switch went off).
const emit = defineEmits(['gone'])

const api = useApi()
let alive = true
onUnmounted(() => { alive = false })

const periodId = ref(BOARD_PERIODS[0].id)
const kind = computed(() => periodKind(periodId.value))
const boards = reactive({ week: { state: 'idle', answer: null }, month: { state: 'idle', answer: null } })

async function loadBoard(which) {
  const slot = boards[which]
  slot.state = 'loading'
  try {
    const answer = await api.get(boardUrl(which))
    if (!alive) return
    slot.answer = answer
    slot.state = 'ready'
  } catch (err) {
    if (!alive) return
    slot.answer = null
    slot.state = 'failed'
    if (isGoneAnswer(err.status)) emit('gone')
  }
}

const boardState = computed(() => boards[kind.value].state)
const board = computed(() => boardView(boards[kind.value].answer, periodId.value))

watch(kind, (which) => { if (boards[which].state === 'idle') loadBoard(which) })
loadBoard(kind.value)
</script>

<style scoped>
.adb {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
  min-width: 0;
}
.adb-periods {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
}
.adb-period {
  min-height: 44px;
  padding: 0 1rem;
  border: 1px solid #d1d5db;
  border-radius: 8px;
  background: #fff;
  color: #374151;
  font: inherit;
  font-size: 0.85rem;
  font-weight: 600;
  cursor: pointer;
}
.adb-period[aria-pressed='true'] {
  border-color: #0369a1;
  background: #e0f2fe;
  color: #0c4a6e;
}
.adb-period:focus-visible,
.adb-retry:focus-visible {
  outline: 2px solid #0369a1;
  outline-offset: 2px;
}
.adb-range {
  margin: 0;
  font-size: 0.82rem;
  font-weight: 700;
  color: #374151;
}
.adb-note {
  margin: 0;
  font-size: 0.82rem;
  line-height: 1.45;
  color: #6b7280;
}
.adb-tile {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  min-width: 0;
  padding: 0.9rem 1rem;
  border: 1px solid #e5e7eb;
  border-radius: 10px;
  background: #fff;
}
.adb-tile-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
}
.adb-tile-title {
  margin: 0;
  font-size: 0.9rem;
  font-weight: 800;
  color: #111827;
}
.adb-soon {
  padding: 0.1rem 0.55rem;
  border-radius: 999px;
  background: #e5e7eb;
  color: #374151;
  font-size: 0.75rem;
  font-weight: 700;
  white-space: nowrap;
}
.adb-rows {
  margin: 0.25rem 0 0;
  padding: 0;
  list-style: none;
}
.adb-row {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  min-height: 44px;
  padding: 0.35rem 0.5rem;
  border-top: 1px solid #f3f4f6;
  font-size: 0.88rem;
}
.adb-rank {
  flex: 0 0 1.5rem;
  font-weight: 800;
  text-align: center;
}
.adb-unit {
  flex: 1 1 auto;
  min-width: 0;
  font-family: 'JetBrains Mono', monospace;
  overflow-wrap: anywhere;
}
.adb-figure {
  flex: 0 0 auto;
  white-space: nowrap;
  color: #111827;
}
.adb-failed {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 0.5rem;
}
.adb-retry {
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
.adb-hos {
  margin: 0;
  padding: 0.75rem;
  border-left: 3px solid #0369a1;
  border-radius: 8px;
  background: #f0f9ff;
  font-size: 0.82rem;
  line-height: 1.5;
  color: #111827;
}
</style>
