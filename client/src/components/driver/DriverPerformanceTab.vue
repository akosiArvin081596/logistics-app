<template>
  <!-- A driver's own week. DriverView shows this only after the server has answered for him.
       Display only: nothing here writes, every figure is the server's, and it reads only his own
       route. Each opening reads afresh, so nothing is kept on the phone. -->
  <div class="perf" data-testid="perf-tab">
    <van-tabs v-model:active="periodId" class="perf-periods" color="#0369a1" title-active-color="#0369a1" data-testid="perf-periods">
      <van-tab v-for="period in OWN_PERIODS" :key="period.id" :name="period.id" :title="period.label" />
    </van-tabs>

    <p v-if="state === 'loading'" class="perf-note" data-testid="perf-loading">Loading&hellip;</p>
    <div v-else-if="!week" class="card perf-failed" role="alert" data-testid="perf-failed">
      <p class="perf-note">{{ FAILED_LINE }}</p>
      <button type="button" class="perf-retry" data-testid="perf-retry" @click="load">Try again</button>
    </div>
    <template v-else>
      <section class="card perf-card" aria-label="My week" data-testid="perf-week">
        <p class="perf-range" data-testid="perf-range">{{ week.range }}</p>
        <div class="perf-head">
          <p class="perf-count" data-testid="perf-count">{{ week.count }}</p>
          <span v-if="week.pace" class="perf-pace" :data-pace="week.paceId" data-testid="perf-pace">{{ week.pace }}</span>
        </div>
        <div class="perf-track" aria-hidden="true">
          <div class="perf-fill" data-testid="perf-fill" :style="{ width: week.width }"></div>
        </div>
        <p v-if="week.left" class="perf-line" data-testid="perf-left">{{ week.left }}</p>
        <p v-if="week.newWeek" class="perf-note" data-testid="perf-new-week">{{ week.newWeek }}</p>
        <p v-if="week.closes" class="perf-note" data-testid="perf-closes">{{ week.closes }}</p>
        <p class="perf-note" data-testid="perf-rule">{{ week.rule }}</p>
      </section>

      <section class="card perf-card" :aria-label="week.title" data-testid="perf-counted">
        <h3 class="perf-title" data-testid="perf-counted-title">{{ week.title }}</h3>
        <ul v-if="week.loads.length" class="perf-loads">
          <li v-for="(item, i) in week.loads" :key="i" class="perf-load" data-testid="perf-load">
            <span class="perf-load-id" data-testid="perf-load-id">{{ item.title }}</span>
            <span class="perf-load-line" data-testid="perf-load-line">{{ item.line }}</span>
          </li>
        </ul>
        <p v-else class="perf-note" data-testid="perf-no-loads">{{ week.empty }}</p>
        <p class="perf-note" data-testid="perf-tell-dispatch">{{ TELL_DISPATCH_LINE }}</p>
      </section>

      <p class="perf-note" data-testid="perf-drive-hours">{{ DRIVE_HOURS_LINE }}</p>
      <p class="perf-note" data-testid="perf-target">{{ TARGET_LINE }}</p>
      <p v-if="week.lowered" class="perf-note" data-testid="perf-lowered">{{ week.lowered }}</p>
      <p class="perf-note" data-testid="perf-requirement">{{ REQUIREMENT_LINE }}</p>
      <p class="perf-note" data-testid="perf-private">{{ PRIVATE_LINE }}</p>
    </template>
  </div>
</template>

<script setup>
import 'vant/es/tabs/style'
import 'vant/es/tab/style'
import { computed, onUnmounted, ref } from 'vue'
import { Tabs as VanTabs, Tab as VanTab } from 'vant'
import { useApi } from '../../composables/useApi'
import {
  DRIVE_HOURS_LINE, FAILED_LINE, OWN_PERIODS, OWN_URL, PRIVATE_LINE, REQUIREMENT_LINE, TARGET_LINE, TELL_DISPATCH_LINE,
  isGoneAnswer, ownWeekView,
} from '../../lib/driverPerformance'

// The server says this viewer has no tab any more (the switch went off, or he has no week to show).
const emit = defineEmits(['gone'])

const api = useApi()
let alive = true
onUnmounted(() => { alive = false })

const periodId = ref(OWN_PERIODS[0].id)
const state = ref('idle')
// Here only, never the store or the browser's storage: a shared phone never shows the previous driver's week.
const answer = ref(null)

async function load() {
  state.value = 'loading'
  try {
    const read = await api.get(OWN_URL)
    if (!alive) return
    answer.value = read
    state.value = 'ready'
  } catch (err) {
    if (!alive) return
    answer.value = null
    state.value = 'failed'
    if (isGoneAnswer(err.status)) emit('gone')
  }
}

const week = computed(() => ownWeekView(answer.value, periodId.value))

load()
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
.perf-card {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  min-width: 0;
}
.perf-range {
  margin: 0;
  font-size: 0.82rem;
  font-weight: 700;
  color: var(--text-dim);
}
.perf-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 0.35rem 0.75rem;
}
.perf-count {
  margin: 0;
  font-size: 1.15rem;
  font-weight: 800;
  color: var(--text);
}
/* A plain word on a pale chip for all three: the label informs, and never scolds. */
.perf-pace {
  padding: 0.15rem 0.6rem;
  border-radius: 999px;
  font-size: 0.78rem;
  font-weight: 700;
  white-space: nowrap;
}
.perf-pace[data-pace='ahead'] { background: #dcfce7; color: #166534; }
.perf-pace[data-pace='on-track'] { background: #e0f2fe; color: #0c4a6e; }
.perf-pace[data-pace='needs-focus'] { background: #e5e7eb; color: #374151; }
.perf-track {
  height: 8px;
  border-radius: 999px;
  background: var(--border);
  overflow: hidden;
}
.perf-fill {
  height: 100%;
  border-radius: 999px;
  background: #0369a1;
}
.perf-line {
  margin: 0;
  font-size: 0.9rem;
  font-weight: 600;
  color: var(--text);
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
.perf-loads {
  margin: 0.25rem 0 0.35rem;
  padding: 0;
  list-style: none;
}
.perf-load {
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
  padding: 0.5rem 0;
  border-top: 1px solid var(--border);
  min-width: 0;
}
.perf-load-id {
  font-size: 0.9rem;
  font-weight: 700;
  color: var(--text);
  overflow-wrap: anywhere;
}
.perf-load-line {
  font-size: 0.82rem;
  color: var(--text-dim);
  overflow-wrap: anywhere;
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
