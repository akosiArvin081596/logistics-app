<template>
  <div class="card">
    <div class="expense-card">
      <div :class="['expense-icon', iconClass]" v-html="typeIcon"></div>
      <div class="expense-details">
        <div class="expense-type">{{ expense.type || 'Other' }}</div>
        <div class="expense-desc">{{ expense.description || expense.date || '' }}</div>
      </div>
      <img
        v-if="expense.photoData && expense.photoData.startsWith('data:')"
        class="expense-thumb"
        :src="expense.photoData"
        alt="Receipt"
      />
      <div>
        <div class="expense-amount">{{ formatCurrency(expense.amount) }}</div>
        <div class="expense-status">{{ expense.status || '' }}</div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  expense: { type: Object, required: true },
})

const typeIcons = {
  Fuel: '&#9981;',
  Repair: '&#128295;',
  Toll: '&#128678;',
  Food: '&#127828;',
  Other: '&#128230;',
}

const typeIcon = computed(() => typeIcons[props.expense.type] || typeIcons.Other)

const iconClass = computed(() => {
  const t = (props.expense.type || 'other').toLowerCase()
  if (t === 'fuel') return 'fuel'
  if (t === 'repair') return 'repair'
  if (t === 'toll') return 'toll'
  if (t === 'food') return 'food'
  return 'other'
})

function formatCurrency(val) {
  const n = parseFloat(String(val || '0').replace(/[$,]/g, ''))
  if (isNaN(n)) return val || '\u2014'
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })
}
</script>

<style scoped>
.expense-card {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.expense-icon {
  width: 40px;
  height: 40px;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 1.1rem;
  flex-shrink: 0;
}

.expense-icon.fuel {
  background: var(--blue-dim);
}

.expense-icon.repair {
  background: var(--danger-dim);
}

.expense-icon.toll {
  background: var(--amber-dim);
}

.expense-icon.food {
  background: var(--accent-dim);
}

.expense-icon.other {
  background: var(--bg);
}

.expense-details {
  flex: 1;
  min-width: 0;
}

.expense-type {
  font-weight: 600;
  font-size: 0.85rem;
}

.expense-desc {
  font-size: 0.75rem;
  color: var(--text-dim);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.expense-amount {
  font-family: 'JetBrains Mono', monospace;
  font-weight: 600;
  font-size: 0.9rem;
  text-align: right;
}

.expense-status {
  font-size: 0.65rem;
  text-align: right;
  color: var(--text-dim);
}

.expense-thumb {
  width: 40px;
  height: 40px;
  border-radius: 6px;
  object-fit: cover;
  border: 1px solid var(--border);
  cursor: pointer;
}
</style>
