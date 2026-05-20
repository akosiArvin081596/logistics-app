<template>
  <div class="expenses-page admin-page">
    <div class="page-header">
      <h2>Expenses</h2>
    </div>
    <div class="expenses-fill">
      <ExpensesTab />
    </div>
  </div>
</template>

<script setup>
// Socket refresh lives inside ExpensesTab itself — keying this child on a
// counter would unmount + remount on every `expenses:changed` event,
// destroying the open detail modal mid-review.
import ExpensesTab from '../components/dashboard/ExpensesTab.vue'
</script>

<style scoped>
.expenses-page { overflow: hidden; }
.expenses-fill {
  flex: 1;
  min-height: 0;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow-y: auto;
}
</style>
