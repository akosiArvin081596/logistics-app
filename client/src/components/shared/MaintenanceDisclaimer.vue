<template>
  <div
    v-if="maintenance.active"
    class="maint-disclaimer"
    :class="{ 'maint-disclaimer--compact': compact }"
    role="note"
  >
    <svg class="maint-disclaimer__icon" viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <circle cx="8" cy="8" r="6" />
      <path d="M8 4.75V8.25L10.25 9.75" />
    </svg>
    <span class="maint-disclaimer__text">{{ maintenance.disclaimer }}</span>
  </div>
</template>

<script setup>
// Sits next to money everywhere earnings/payouts are shown, so an investor who
// dismissed the maintenance popup and scrolled past the banner still sees that
// the figures beside it aren't final. Reads the store directly (no props feed
// it data) so every call site stays a one-line drop-in; when the flag is off
// `maintenance.active` is false and this renders nothing at all.
import { useMaintenanceStore } from '../../stores/maintenance'

defineProps({
  // Compact = a tight single-line chip for sitting under a section header,
  // beside the figures it caveats. Non-compact (default) = a roomier callout
  // block for a page-level placement (page header, top of dashboard content).
  //
  // Every mount today passes `compact`, and that is a convention rather than
  // an accident: the caveat belongs beside the money, so it is mounted inside
  // EarningsSection and PayoutsSection and nowhere else. Before adding a
  // page-level one, read the comment at the top of views/MyPayoutsView.vue —
  // it explains why stacking a second copy near a section's own reads as a
  // glitch. The non-compact block is kept for a page that genuinely has no
  // section to hang it off.
  compact: { type: Boolean, default: false },
})

const maintenance = useMaintenanceStore()
</script>

<style scoped>
/* Amber advisory — the same warning family already used across the investor
   portal (--amber / --amber-dim, e.g. PayoutsSection's status pills and
   phase-note). Deliberately quieter than the red top banner it complements:
   this is a footnote-grade caveat beside financial figures, not an alert.
   Text/icon colors are the exact shades PayoutsSection already uses for its
   own amber pill (#92400e) and amber total (#b45309), not the raw --amber
   token, which is too light for body text on a white/tinted background. */
.maint-disclaimer {
  display: flex;
  align-items: flex-start;
  gap: 0.45rem;
  background: var(--amber-dim, rgba(245, 158, 11, 0.1));
  border: 1px solid var(--amber, #f59e0b);
  border-radius: var(--radius, 10px);
  padding: 0.55rem 0.8rem;
  margin-bottom: 0.9rem;
}

.maint-disclaimer__icon {
  flex: none;
  margin-top: 0.15rem;
  color: #b45309;
}

.maint-disclaimer__text {
  min-width: 0;
  color: #92400e;
  font-size: 0.78rem;
  font-weight: 600;
  line-height: 1.45;
}

/* Compact: an inline pill that sits on its own line under a section header
   without pushing the figures below it down much — mirrors this codebase's
   .status-pill treatment (light amber fill, dark amber text, no border)
   rather than the heavier bordered block above. min-width:0 on the text span
   (not the default flex "auto") is what lets it actually wrap instead of
   overflowing once the pill is narrower than the sentence. */
.maint-disclaimer--compact {
  display: inline-flex;
  align-items: center;
  max-width: 100%;
  border: none;
  border-radius: 999px;
  padding: 0.25rem 0.65rem;
  margin-bottom: 0.75rem;
}
.maint-disclaimer--compact .maint-disclaimer__icon {
  margin-top: 0;
}
.maint-disclaimer--compact .maint-disclaimer__text {
  font-size: 0.68rem;
  line-height: 1.3;
}
</style>
