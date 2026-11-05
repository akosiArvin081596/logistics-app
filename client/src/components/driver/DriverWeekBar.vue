<template>
  <!-- The load page's bar: his own week at a glance, and a tap into the Performance tab. It is
       handed a view of the server's figures, or none, and reads nothing itself. The place keeps
       one height with or without the button, so the bar coming or going never moves what is
       below it under his thumb. Still by design: nothing on it moves or hurries him. -->
  <div class="week-bar-slot" data-testid="perf-bar-slot">
    <button v-if="bar" type="button" class="week-bar" data-testid="perf-bar" @click="emit('open')">
      <span class="week-bar-top">
        <span class="week-bar-text" data-testid="perf-bar-text">{{ bar.text }}</span>
        <span v-if="bar.pace" class="week-bar-pace" :data-pace="bar.paceId" data-testid="perf-bar-pace">{{ bar.pace }}</span>
      </span>
      <span class="week-bar-track" aria-hidden="true">
        <span class="week-bar-fill" data-testid="perf-bar-fill" :style="{ width: bar.width }"></span>
      </span>
      <span class="week-bar-hos" data-testid="perf-bar-hos">{{ bar.hos }}</span>
    </button>
  </div>
</template>

<script setup>
defineProps({
  bar: { type: Object, default: null },
})
const emit = defineEmits(['open'])
</script>

<style scoped>
.week-bar-slot {
  height: 4.75rem;
  margin-bottom: 0.75rem;
}
.week-bar {
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 0.35rem;
  box-sizing: border-box;
  width: 100%;
  height: 100%;
  min-height: 44px;
  padding: 0.5rem 0.85rem;
  overflow: hidden;
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
  outline-offset: -2px;
}
.week-bar-top {
  display: flex;
  flex-wrap: nowrap;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  min-width: 0;
}
.week-bar-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 0.85rem;
  font-weight: 700;
}
/* A plain word on a pale chip for all three: the label informs, and never scolds. */
.week-bar-pace {
  flex: none;
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
  flex: none;
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
/* The narrowest phones still fit the figure and the label on one row. */
@media (max-width: 359px) {
  .week-bar { padding-inline: 0.6rem; }
  .week-bar-text { font-size: 0.78rem; }
  .week-bar-pace { padding-inline: 0.4rem; font-size: 0.68rem; }
}
</style>
