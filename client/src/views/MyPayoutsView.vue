<template>
  <div class="admin-page my-payouts-page">
    <div class="page-header">
      <h2>Payouts</h2>
      <p class="page-sub">
        Your monthly settlements &mdash; what's accruing this month, and what's owed, processing, or paid.
      </p>
    </div>

    <!-- No previewUserId → the section scopes to the logged-in investor. -->
    <PayoutsSection />
  </div>
</template>

<script setup>
import PayoutsSection from '../components/investor/PayoutsSection.vue'
</script>

<style scoped>
.my-payouts-page {
  gap: 1rem;
  padding-bottom: 2rem;
}
.page-header h2 { font-size: 1.4rem; margin: 0; }
.page-sub {
  font-size: 0.82rem;
  color: var(--text-dim);
  margin-top: 0.2rem;
  max-width: 720px;
  line-height: 1.45;
}
</style>
