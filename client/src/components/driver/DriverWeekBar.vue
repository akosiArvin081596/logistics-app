<template>
  <!-- The load page's bar: his own week at a glance, and a tap into the Performance tab. It is
       handed a view of the server's figures and reads nothing itself. Still by design: nothing on
       it moves or hurries him. -->
  <button type="button" class="week-bar" data-testid="perf-bar" @click="emit('open')">
    <span class="week-bar-top">
      <span class="week-bar-text" data-testid="perf-bar-text">{{ bar.text }}</span>
      <span v-if="bar.pace" class="week-bar-pace" :data-pace="bar.paceId" data-testid="perf-bar-pace">{{ bar.pace }}</span>
    </span>
    <span class="week-bar-track" aria-hidden="true">
      <span class="week-bar-fill" data-testid="perf-bar-fill" :style="{ width: bar.width }"></span>
    </span>
    <span class="week-bar-hos" data-testid="perf-bar-hos">{{ bar.hos }}</span>
  </button>
</template>

<script setup>
defineProps({
  bar: { type: Object, required: true },
})
const emit = defineEmits(['open'])
</script>

<style scoped>
.week-bar {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  width: 100%;
  min-height: 44px;
  margin-bottom: 0.75rem;
  padding: 0.6rem 0.85rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  color: var(--text);
  font-family: inherit;
  text-align: left;
  cursor: pointer;
}
.week-bar:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.week-bar-top {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 0.25rem 0.5rem;
}
.week-bar-text {
  font-size: 0.85rem;
  font-weight: 700;
}
/* A plain word on a pale chip for all three: the label informs, and never scolds. */
.week-bar-pace {
  padding: 0.1rem 0.55rem;
  border-radius: 999px;
  font-size: 0.72rem;
  font-weight: 700;
  white-space: nowrap;
}
.week-bar-pace[data-pace='ahead'] { background: #dcfce7; color: #166534; }
.week-bar-pace[data-pace='on-track'] { background: #e0f2fe; color: #0c4a6e; }
.week-bar-pace[data-pace='needs-focus'] { background: #e5e7eb; color: #374151; }
.week-bar-track {
  display: block;
  height: 6px;
  border-radius: 999px;
  background: var(--border);
  overflow: hidden;
}
.week-bar-fill {
  display: block;
  height: 100%;
  border-radius: 999px;
  background: #0369a1;
}
.week-bar-hos {
  font-size: 0.72rem;
  color: var(--text-dim);
}
</style>
