<template>
  <span v-if="text" class="basis-badge" :class="'basis-' + basis" :title="title">{{ text }}</span>
</template>

<script setup>
import { computed } from 'vue'
import { basisLabel, basisTitle } from '../../lib/financialsView'

// Settled / Live / Mixed: whether a period's figures are closed months as they
// settled, open months calculated live, or both. The server decides (`basis`).
const props = defineProps({
  basis: { type: String, default: '' },
  // 'none' periods have nothing to badge in a header; a caller can opt in.
  showNone: { type: Boolean, default: false },
})

const text = computed(() => (props.basis === 'none' && !props.showNone ? '' : basisLabel(props.basis)))
const title = computed(() => basisTitle(props.basis))
</script>

<style scoped>
.basis-badge {
  display: inline-block;
  padding: 0.05rem 0.4rem;
  font-size: 0.6rem;
  font-weight: 700;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  border-radius: 999px;
  white-space: nowrap;
  vertical-align: middle;
  cursor: help;
}
.basis-settled { color: #334155; background: #e2e8f0; }
.basis-live { color: #065f46; background: #d1fae5; }
.basis-mixed { color: #92400e; background: #fef3c7; }
.basis-none { color: var(--text-dim); background: var(--bg); }
</style>
