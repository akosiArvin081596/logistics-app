<template>
  <div class="expenses-page admin-page">
    <div class="page-header">
      <h2>Expenses</h2>
    </div>
    <div class="expenses-fill">
      <ExpensesTab :focus-expense-id="focusExpenseId" @focus-consumed="onFocusConsumed" />
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
// Socket refresh lives inside ExpensesTab itself — keying this child on a
// counter would unmount + remount on every `expenses:changed` event,
// destroying the open detail modal mid-review.
import ExpensesTab from '../components/dashboard/ExpensesTab.vue'

// Deep link into one receipt: /expenses?expense=<id>, currently emitted by the
// Data Issues duplicate-receipt queue. Copied from DashboardView's ?load=
// handling so both deep links behave the same way: the view reads the query, the
// tab owns the modal and reports back, and the param is dropped once consumed.
const route = useRoute()
const router = useRouter()
const focusExpenseId = ref('')

function applyRouteFocus() {
  const v = (route.query.expense ?? '').toString().trim()
  if (v) focusExpenseId.value = v
}

// ExpensesTab reports back on EVERY outcome, not only on a hit — the row may be
// filtered out or gone, and those already got their answer on screen. Leaving
// the param behind would replay that answer on the next refresh (and re-open a
// modal the admin had closed), which is the half of this the ?load= precedent
// does not do.
function onFocusConsumed() {
  focusExpenseId.value = ''
  if (route.query.expense !== undefined) {
    router.replace({ path: route.path, query: { ...route.query, expense: undefined } })
  }
}

onMounted(applyRouteFocus)
// Re-apply when navigated into with a new ?expense= while already on the page.
watch(() => route.query.expense, applyRouteFocus)
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
