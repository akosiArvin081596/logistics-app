<template>
  <section class="section toolbar" aria-label="Report options">
    <div class="toolbar-row">
      <div class="control-group">
        <span :id="ids.range" class="control-label">Range</span>
        <div class="seg" role="group" :aria-labelledby="ids.range">
          <button
            v-for="p in RANGE_PRESETS"
            :key="p.key"
            type="button"
            class="seg-btn"
            :class="{ active: selection.range === p.key }"
            :aria-pressed="selection.range === p.key"
            @click="pickRange(p.key)"
          >{{ p.label }}</button>
        </div>
      </div>
      <div v-if="selection.range === 'custom'" class="control-group dates">
        <label class="date-field">
          <span class="control-label">From</span>
          <input
            type="date"
            class="form-input date-input"
            :value="selection.from"
            :max="selection.to || undefined"
            @change="onDate('from', $event.target.value)"
          />
        </label>
        <label class="date-field">
          <span class="control-label">To</span>
          <input
            type="date"
            class="form-input date-input"
            :value="selection.to"
            :min="selection.from || undefined"
            @change="onDate('to', $event.target.value)"
          />
        </label>
      </div>
    </div>

    <div class="toolbar-row">
      <div class="control-group">
        <span :id="ids.granularity" class="control-label">View by</span>
        <div class="seg" role="group" :aria-labelledby="ids.granularity">
          <button
            v-for="g in GRANULARITIES"
            :key="g.key"
            type="button"
            class="seg-btn"
            :class="{ active: selection.granularity === g.key }"
            :aria-pressed="selection.granularity === g.key"
            :title="g.key === 'week' ? 'Weeks run Saturday to Friday' : undefined"
            @click="emit('update', { granularity: g.key })"
          >{{ g.label }}<span v-if="g.hint" class="seg-hint"> ({{ g.hint }})</span></button>
        </div>
      </div>
      <div class="actions">
        <a
          v-if="exportHref"
          class="btn btn-secondary btn-action"
          :href="exportHref"
          download
        ><Download class="icon" aria-hidden="true" />Export CSV</a>
        <button v-else type="button" class="btn btn-secondary btn-action" disabled>
          <Download class="icon" aria-hidden="true" />Export CSV
        </button>
        <button type="button" class="btn btn-secondary btn-action" @click="emit('open-settings')">
          <SlidersHorizontal class="icon" aria-hidden="true" />Cost settings
        </button>
      </div>
    </div>

    <Tabs :model-value="selection.groupBy" @update:model-value="(v) => emit('update', { groupBy: v })">
      <TabsList class="group-tabs" aria-label="Group the report by">
        <TabsTrigger v-for="g in GROUPINGS" :key="g.key" :value="g.key" class="group-tab">
          {{ g.label }}
        </TabsTrigger>
      </TabsList>
    </Tabs>
  </section>
</template>

<script setup>
import { useId } from 'vue'
import { Download, SlidersHorizontal } from 'lucide-vue-next'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { GRANULARITIES, GROUPINGS, RANGE_PRESETS } from '../../lib/financialsView'

// The report's controls. The page owns the selection (it lives in the URL);
// this only says what changed.
const props = defineProps({
  // { range, from, to, granularity, groupBy } (lib/financialsView.js readSelection)
  selection: { type: Object, required: true },
  // The CSV link for the same query, or '' while the selection is not valid.
  exportHref: { type: String, default: '' },
})
const emit = defineEmits(['update', 'open-settings'])

const uid = useId()
const ids = { range: `fin-range-${uid}`, granularity: `fin-gran-${uid}` }

function pickRange(key) {
  if (key === props.selection.range) return
  // Custom opens on the dates already shown, so nothing moves until one is edited.
  if (key === 'custom') emit('update', { range: 'custom', from: props.selection.from, to: props.selection.to })
  else emit('update', { range: key })
}

function onDate(which, value) {
  if (!value || value === props.selection[which]) return
  emit('update', { range: 'custom', from: props.selection.from, to: props.selection.to, [which]: value })
}
</script>

<style scoped>
.toolbar {
  display: flex;
  flex-direction: column;
  gap: 0.85rem;
}
.toolbar-row {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 0.75rem 1.25rem;
}
.control-group {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  min-width: 0;
}
.control-group.dates {
  flex-direction: row;
  gap: 0.6rem;
}
.control-label {
  font-size: 0.68rem;
  font-weight: 600;
  color: var(--text-dim);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.seg {
  display: flex;
  flex-wrap: wrap;
  gap: 0.3rem;
}
.seg-btn {
  padding: 0.35rem 0.7rem;
  font-family: inherit;
  font-size: 0.78rem;
  font-weight: 600;
  color: var(--text);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.15s;
  white-space: nowrap;
}
.seg-btn:hover { border-color: var(--accent); color: var(--accent); }
.seg-btn.active {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}
.seg-btn:focus-visible,
.btn-action:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.seg-hint { font-weight: 500; opacity: 0.8; }
.date-field {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}
.date-input {
  padding: 0.4rem 0.6rem;
  font-size: 0.8rem;
  min-width: 9.5rem;
}
.actions {
  margin-left: auto;
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}
.btn-action {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  text-decoration: none;
}
.btn-action:disabled { opacity: 0.5; cursor: not-allowed; }
.icon { width: 15px; height: 15px; }
.group-tabs {
  display: flex;
  justify-content: flex-start;
  max-width: 100%;
  overflow-x: auto;
  height: auto;
}
.group-tab { font-size: 0.8rem; }

@media (max-width: 767px) {
  .actions { margin-left: 0; width: 100%; }
  .actions > * { flex: 1 1 0; justify-content: center; }
  .control-group.dates { width: 100%; }
  .date-field { flex: 1 1 0; }
  .date-input { min-width: 0; width: 100%; }
}
</style>
