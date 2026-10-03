<template>
  <tr class="group-row" :class="{ open: expanded }" @click="emit('toggle')">
    <th scope="row" class="sticky-col label-cell">
      <div class="label-line">
        <button
          type="button"
          class="expand-btn"
          :aria-expanded="expanded"
          :aria-label="`${expanded ? 'Hide' : 'Show'} ${group.label} by period`"
          @click.stop="emit('toggle')"
        >
          <ChevronRight class="chev" :class="{ rotated: expanded }" aria-hidden="true" />
        </button>
        <span class="label-text" :class="{ mono: !!group.load, muted }">{{ group.label }}</span>
      </div>
      <div v-if="group.load" class="load-meta">
        <span>{{ group.load.truck || 'No truck' }}</span>
        <span>{{ group.load.driver || 'No driver' }}</span>
        <span v-if="group.load.assignedDate">Assigned {{ fmtYmd(group.load.assignedDate) }}</span>
        <span>{{ group.load.pickupState || '?' }} → {{ group.load.deliveryState || '?' }}</span>
        <span>{{ milesSourceLabel(group.load.milesSource) }}</span>
      </div>
    </th>
    <td v-for="c in GROUP_COLUMNS" :key="c.key" class="num" :class="c.signed ? signClass(group.total?.[c.key]) : ''">
      {{ formatColumn(group.total, c) }}
    </td>
  </tr>
  <template v-if="expanded">
    <tr v-for="p in rowPeriods" :key="p.key" class="period-row">
      <th scope="row" class="sticky-col period-cell">
        <span>{{ p.label }}</span>
        <BasisBadge :basis="group.byPeriod[p.key].basis" class="period-badge" />
      </th>
      <td v-for="c in GROUP_COLUMNS" :key="c.key" class="num" :class="c.signed ? signClass(group.byPeriod[p.key][c.key]) : ''">
        {{ formatColumn(group.byPeriod[p.key], c) }}
      </td>
    </tr>
  </template>
</template>

<script setup>
import { computed } from 'vue'
import { ChevronRight } from 'lucide-vue-next'
import BasisBadge from './BasisBadge.vue'
import { fmtYmd } from '../../utils/datetime'
import { GROUP_COLUMNS, formatColumn, milesSourceLabel, signClass } from '../../lib/financialsView'

// One group's row and, when open, its figures for each period it has any in.
const props = defineProps({
  group: { type: Object, required: true },
  periods: { type: Array, required: true },
  expanded: { type: Boolean, default: false },
  // A shared or unallocated bucket (lib/financialsView.js isCatchAllGroup).
  muted: { type: Boolean, default: false },
})
const emit = defineEmits(['toggle'])

const rowPeriods = computed(() => props.periods.filter((p) => props.group.byPeriod && props.group.byPeriod[p.key]))
</script>

<style scoped>
.group-row { cursor: pointer; }
.group-row:hover > *, .group-row.open > * { background: var(--bg); }
.label-cell { font-weight: 600; }
.label-line {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  min-width: 0;
}
.label-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.label-text.mono { font-family: 'JetBrains Mono', monospace; }
.expand-btn {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: none;
  color: var(--text-dim);
  cursor: pointer;
}
.expand-btn:hover { background: var(--surface-hover); color: var(--text); }
.expand-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.chev { width: 15px; height: 15px; transition: transform 0.15s; }
.chev.rotated { transform: rotate(90deg); }
.load-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 0.15rem 0.6rem;
  margin: 0.2rem 0 0 1.6rem;
  font-size: 0.68rem;
  font-weight: 500;
  color: var(--text-dim);
}
.period-row > * { background: #fafbfd; font-size: 0.76rem; }
.period-cell {
  font-weight: 500;
  padding-left: 2.1rem !important;
  color: var(--text-dim);
  white-space: nowrap;
}
.period-badge { margin-left: 0.4rem; }
.label-text.muted { font-style: italic; color: var(--text-dim); }
</style>
