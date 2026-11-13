<template>
  <router-link v-if="shown" :to="{ name: PAGE_ROUTE_NAME }" class="payroll-check-link" data-testid="payroll-check-link">{{ WORDS.link }}</router-link>
</template>

<script setup>
import { computed } from 'vue'
import { useApi } from '../../composables/useApi'
import { useAuthStore } from '../../stores/auth'
import { usePayrollCheckSwitch } from '../../composables/usePayrollCheckSwitch.js'
import { PAGE_ROUTE_NAME, WORDS, canSeePayrollCheck } from '../../lib/payrollCheck.js'

// Invoices' way to the before-payroll check: a Super Admin's, shown only while the server has the
// check switched on. Any other role renders nothing and asks nothing; the route's gate is the real one.
const auth = useAuthStore()
const on = usePayrollCheckSwitch(useApi(), auth.user?.role)
const shown = computed(() => canSeePayrollCheck(auth.user?.role) && on.value)
</script>

<style scoped>
/* Beside Invoices' outline buttons, in their size and border. */
.payroll-check-link {
  display: inline-flex;
  align-items: center;
  height: 2.25rem;
  padding: 0 1rem;
  border: 1px solid #e2e4ea;
  border-radius: 0.375rem;
  background: #fff;
  color: #111827;
  font-size: 12px;
  font-weight: 500;
  text-decoration: none;
  white-space: nowrap;
}
.payroll-check-link:hover,
.payroll-check-link:focus-visible {
  background: #f9fafb;
  border-color: #cbd5e1;
}
/* A finger needs a taller target than a mouse. */
@media (max-width: 767px) {
  .payroll-check-link { height: 2.75rem; }
}
</style>
