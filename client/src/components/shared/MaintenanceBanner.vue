<template>
  <!-- The v-if IS the component: when maintenance mode is off (or the
       viewer isn't in the configured audience, or config hasn't loaded
       yet), this renders nothing at all — no placeholder, no reserved
       space, nothing for a screen reader to even skip past. -->
  <div
    v-if="maintenance.active"
    class="maintenance-banner"
    role="status"
    aria-live="polite"
  >
    <svg
      class="banner-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
    <div class="banner-text">
      <div class="banner-title">{{ maintenance.title }}</div>
      <div class="banner-message">{{ maintenance.message }}</div>
    </div>
  </div>
</template>

<script setup>
// No props, no emits — this is a pure store reader mounted unconditionally
// by App.vue. It decides its own visibility from `maintenance.active`.
// Deliberately does NOT call fetchConfig(): App.vue owns the single
// fetch-on-load so the banner, the popup modal, and the inline disclaimer
// all react to one request instead of racing three independent ones.
import { useMaintenanceStore } from '../../stores/maintenance'

const maintenance = useMaintenanceStore()
</script>

<style scoped>
/* Client's brief, verbatim: "big and bold and red... but don't knock him
   out of it." Sticky (not fixed) + no overlay/backdrop + no pointer-events
   trickery = it rides along at the top of the scrollable dashboard but
   never traps focus, covers a control, or blocks a click the way a fixed
   full-bleed banner or a modal would. Purely informational. */
.maintenance-banner {
  position: sticky;
  top: 0;
  box-sizing: border-box;

  /* The cap is the other half of "don't knock him out of it", and it is not
     cosmetic. As a flex item of .main (shared.css: height 100vh, overflow-y
     auto, flex column) nothing used to stop this banner GROWING, and a sticky
     element tall enough to fill the scrollport pins there permanently:
     scrolling still "works", it just never brings anything into view.
     Measured on a 375x667 phone with the mobile type scale, ~1,300 characters
     of MAINTENANCE_NOTICE_MESSAGE leaves a 32px sliver of the dashboard and
     ~1,400 leaves none at all — one pasted paragraph, set by an operator
     editing an env var, with no code review or deploy in the way. So the
     banner scrolls its own overflow instead of eating the page.
     This is NOT made redundant by server.js clamping the copy
     (MAINTENANCE_NOTICE_MAX): a message at that 400-char ceiling still
     measures 259px on a 375px phone — taller than the mobile cap below — and
     this component renders whatever the API hands it, so the last line of
     defence belongs here. If that ceiling moves, re-measure; don't assume.
     overscroll-behavior is deliberately left at
     `auto`: once the banner's internal scroll reaches its end, a continued
     swipe chains through to the page, which is what an investor expects —
     `contain` would strand the swipe here, re-creating the trap by hand.
     Note for whoever revisits this: a capped banner only overflows on copy
     this long, and screen readers still get the whole message from the live
     region regardless of scroll position, but a sighted keyboard-only user
     on a browser without keyboard-focusable scrollers can't reach the tail
     of it. If that ever matters, the fix is tabindex="0" on the region when
     (and only when) it actually overflows — not an unconditional tab stop. */
  max-height: 35vh;
  overflow-y: auto;

  /* `flex: none` is REQUIRED, not tidying, and it has to sit next to the
     overflow rule above. A flex item's automatic minimum size (min-height:
     auto) is what normally stops this banner being crushed — but the spec
     zeroes that minimum the moment the item becomes a scroll container. So
     `overflow-y: auto` on its own silently hands .main permission to shrink
     the banner, and .main's free space is negative on any real dashboard, so
     it shrinks it all the way to a 30px empty red strip with every word of
     the notice hidden inside. Measured, not theorised. Pinning flex-shrink at
     0 keeps the height content-driven, with max-height as the only ceiling. */
  flex: none;

  /* Sits below the mobile drawer's backdrop (z-index: 40, see App.vue) on
     purpose: when the drawer opens, its backdrop dims EVERYTHING behind
     it, and the banner has to lose that stacking fight along with the
     rest of the page rather than floating above the dim. It still sits
     above ordinary page content (which carries no z-index of its own),
     and below the hamburger button (z-index: 50) and the drawer itself
     (z-index: 60) — the exact layer order App.vue documents. */
  z-index: 30;

  display: flex;
  align-items: center;
  /* `wrap` became load-bearing once the box above gained a ceiling, so don't
     "simplify" it to nowrap: a long message's hypothetical main size overflows
     the row, which drops the text onto its own flex line, and align-items:
     center is then centring a line that is exactly as tall as its content —
     i.e. a no-op. With nowrap the single line inherits the capped container's
     height instead, centring the taller text inside it and putting its first
     line ~170px ABOVE the scroll origin, unreachable because scrollTop cannot
     go negative. Measured both ways. */
  flex-wrap: wrap;
  gap: 0.85rem;

  padding: 1rem 1.5rem;
  background: linear-gradient(90deg, #dc2626, #b91c1c);
  border-bottom: 3px solid #7f1d1d;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.25);
  color: #fff;
}

.banner-icon {
  flex-shrink: 0;
  width: 28px;
  height: 28px;
  /* Subtle "draw the eye" pulse — icon only, so the text stays rock
     steady and never gets harder to read mid-animation. */
  animation: maintenance-pulse 1.8s ease-in-out infinite;
}

@keyframes maintenance-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.5;
  }
}

/* Stops the pulse entirely for anyone who has asked their OS for less
   motion, per the client's "loud but not obnoxious" ask. */
@media (prefers-reduced-motion: reduce) {
  .banner-icon {
    animation: none;
  }
}

.banner-text {
  min-width: 0;
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
}

.banner-title {
  font-size: 1.1rem;
  font-weight: 800;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  line-height: 1.2;
  /* color: inherited #fff from .maintenance-banner */
}

.banner-message {
  font-size: 0.9rem;
  font-weight: 600;
  line-height: 1.35;
  /* color: inherited #fff from .maintenance-banner — kept plain white
     rather than a translucent tint so contrast against the red gradient
     never drifts below AA regardless of scroll position. */
}

/* Matches useViewport's BREAKPOINT (768px, i.e. "mobile" = max-width:
   767px), so this activates on exactly the widths where App.vue's fixed
   hamburger button is showing (top: 0.6rem; left: 0.6rem; 44x44px;
   z-index: 50 — above this banner's 30). That button floats ON TOP of
   the banner there, opaque, so without this the title/icon would render
   partly hidden underneath it. Left padding pushes all banner content
   clear of the button's right edge instead of trying to route text
   around a floating square. */
@media (max-width: 767px) {
  .maintenance-banner {
    padding: 0.85rem 1rem 0.85rem calc(0.6rem + 44px + 0.75rem);
    gap: 0.65rem;
    /* Tighter than the desktop 35vh for two reasons. (1) The banner starts
       below .main's 3rem mobile top padding, so on a 375x667 phone a 35vh cap
       actually consumes 281px — 42% of the screen — before the dashboard gets
       a pixel; 30vh brings that to ~37%. (2) `vh` on mobile resolves against
       the LARGE viewport (URL bar retracted), so the share of what the
       investor can actually see is larger still. Same unit as .main's own
       `height: 100vh` on purpose: the cap stays an exact fraction of the
       scrollport it must not swallow, which a dvh/vh mix would break. */
    max-height: 30vh;
  }
  .banner-icon {
    width: 24px;
    height: 24px;
  }
  .banner-title {
    font-size: 0.95rem;
  }
  .banner-message {
    font-size: 0.8rem;
  }
}
</style>
