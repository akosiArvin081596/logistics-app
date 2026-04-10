<template>
  <div class="expenses-page admin-page">
    <div class="page-header">
      <h2>Expenses</h2>
    </div>
    <div class="expenses-fill">
      <ExpensesTab :key="refreshKey" />
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue'
import ExpensesTab from '../components/dashboard/ExpensesTab.vue'
import { useSocketRefresh } from '../composables/useSocketRefresh'

const refreshKey = ref(0)
useSocketRefresh('expenses:changed', () => { refreshKey.value++ })
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
