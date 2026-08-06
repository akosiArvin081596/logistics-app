<template>
  <div class="admin-page my-payouts-page">
    <div class="page-header">
      <h2>Payouts</h2>
      <p class="page-sub">
        Your monthly settlements &mdash; what's accruing this month, and what's owed, processing, or paid.
      </p>
    </div>

    <!-- No maintenance disclaimer here on purpose, and the same call is made on
         the investor dashboard — this comment is the one place the rule is
         written down. MaintenanceDisclaimer is mounted at SECTION level only,
         compact, exactly twice: EarningsSection and PayoutsSection, each
         directly under its own section title. No page-level copies.
         Why: the caveat has to travel with the figures it qualifies, so it
         lands beside the money wherever those sections are mounted, and it
         can't be scrolled away from them. A page-level copy adds nothing —
         here it would sit a few pixels above PayoutsSection's own, and on
         /investor it would sit one row above EarningsSection's. Two amber
         callouts that close together read as a rendering glitch, and with the
         red maintenance banner overhead that would be three renderings of the
         same sentence on one screen, which reads as broken rather than
         emphatic. -->

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
