<template>
  <!-- The Super Admin's board on /driver. DriverView shows this only after the server has answered
       for this viewer, and never to a Driver. Display only: nothing here writes, every figure is
       the server's, and each opening reads afresh, so no rows are kept on the phone. -->
  <div class="perf" data-testid="perf-board">
    <van-tabs v-model:active="periodId" class="perf-periods" color="#0369a1" title-active-color="#0369a1" data-testid="perf-periods">
      <van-tab v-for="period in PERIODS" :key="period.id" :name="period.id" :title="period.label" />
    </van-tabs>

    <p v-if="boardState === 'loading'" class="perf-note" data-testid="perf-board-loading">Loading&hellip;</p>
    <div v-else-if="!board" class="card perf-failed" role="alert" data-testid="perf-board-failed">
      <p class="perf-note">{{ FAILED_LINE }}</p>
      <button type="button" class="perf-retry" data-testid="perf-board-retry" @click="loadBoard(kind)">Try again</button>
    </div>
    <template v-else>
      <p class="perf-range" data-testid="perf-range">{{ board.range }}</p>
      <p v-if="board.closes" class="perf-closes" data-testid="perf-closes">{{ board.closes }}</p>
      <section v-for="tile in board.tiles" :key="tile.id" class="card perf-tile" :data-category="tile.id" data-testid="perf-tile">
        <div class="perf-tile-head">
          <h3 class="perf-title">{{ tile.title }}</h3>
          <van-tag v-if="tile.comingSoon" color="#e5e7eb" text-color="#374151" data-testid="perf-soon">{{ COMING_SOON }}</van-tag>
        </div>
        <p class="perf-note" data-testid="perf-line">{{ tile.line }}</p>
        <ol v-if="tile.rows.length" class="perf-rows">
          <li v-for="(row, i) in tile.rows" :key="i" :class="['perf-row', { 'perf-row-you': row.you }]" data-testid="perf-row">
            <span class="perf-rank">{{ row.rank }}</span>
            <span class="perf-unit">{{ row.unit }}</span>
            <van-tag v-if="row.you" class="perf-you" color="#e0f2fe" text-color="#0c4a6e" data-testid="perf-you">{{ YOU }}</van-tag>
            <span class="perf-figure">{{ row.figure }}</span>
          </li>
        </ol>
        <p v-else-if="!tile.comingSoon" class="perf-note" data-testid="perf-empty">{{ EMPTY_LINE }}</p>
      </section>
    </template>
  </div>
</template>

<script setup>
import 'vant/es/tabs/style'
import 'vant/es/tab/style'
import 'vant/es/tag/style'
import { computed, onUnmounted, reactive, ref, watch } from 'vue'
import { Tabs as VanTabs, Tab as VanTab, Tag as VanTag } from 'vant'
import { useApi } from '../../composables/useApi'
import {
  COMING_SOON, EMPTY_LINE, FAILED_LINE, PERIODS, YOU,
  boardUrl, boardView, isGoneAnswer, periodKind,
} from '../../lib/driverPerformance'

// The server says this viewer has no tab any more (the switch went off).
const emit = defineEmits(['gone'])

const api = useApi()
let alive = true
onUnmounted(() => { alive = false })

const periodId = ref(PERIODS[0].id)
const kind = computed(() => periodKind(periodId.value))
const boards = reactive({ week: { state: 'idle', answer: null }, month: { state: 'idle', answer: null } })

async function read(slot, url) {
  slot.state = 'loading'
  try {
    const answer = await api.get(url)
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
function loadBoard(which) {
  return read(boards[which], boardUrl(which))
}

const boardState = computed(() => boards[kind.value].state)
const board = computed(() => boardView(boards[kind.value].answer, periodId.value))

watch(kind, (which) => { if (boards[which].state === 'idle') loadBoard(which) })
loadBoard(kind.value)
</script>

<style scoped>
.perf {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  width: 100%;
  max-width: 640px;
  margin: 0 auto;
  min-width: 0;
}
.perf-periods {
  --van-tabs-line-height: 44px;
  border-radius: 12px;
  overflow: hidden;
}
.perf-range {
  margin: 0;
  font-size: 0.82rem;
  font-weight: 700;
  color: var(--text);
}
.perf-closes {
  margin: -0.5rem 0 0;
  font-size: 0.78rem;
  color: var(--text-dim);
}
.perf-tile {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  min-width: 0;
}
.perf-tile-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
}
.perf-title {
  margin: 0;
  font-size: 0.95rem;
  font-weight: 800;
}
.perf-note {
  margin: 0;
  font-size: 0.82rem;
  line-height: 1.45;
  color: var(--text-dim);
}
.perf-rows {
  margin: 0.25rem 0 0;
  padding: 0;
  list-style: none;
}
.perf-row {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  min-height: 44px;
  padding: 0.35rem 0.5rem;
  border-top: 1px solid var(--border);
  font-size: 0.9rem;
}
.perf-row-you {
  border-radius: 8px;
  background: var(--accent-dim);
  font-weight: 700;
}
.perf-rank {
  flex: 0 0 1.5rem;
  font-weight: 800;
  text-align: center;
}
.perf-unit {
  flex: 1 1 auto;
  min-width: 0;
  overflow-wrap: anywhere;
}
.perf-you {
  flex: 0 0 auto;
}
.perf-figure {
  flex: 0 0 auto;
  white-space: nowrap;
  color: var(--text);
}
.perf-failed {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 0.5rem;
}
.perf-retry {
  min-height: 44px;
  margin-top: 0.5rem;
  padding: 0 1rem;
  border: 1px solid #0369a1;
  border-radius: 8px;
  background: transparent;
  color: #0369a1;
  font-family: inherit;
  font-size: 0.85rem;
  font-weight: 700;
  cursor: pointer;
}
</style>
