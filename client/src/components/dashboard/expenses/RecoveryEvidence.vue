<template>
  <!-- The evidence behind one verdict. The point of this component is that a
       human decides whether to trust a machine reading, and a number on its own
       is not evidence — "$9.00/gal" only means something next to the range it
       violates. So the price is DRAWN against the fleet's own band rather than
       printed beside it.

       Renders nothing at all when the server sent no evidence for this row (a
       closed month, a missing file). Absent is not zero and not a dash. -->
  <div v-if="anyEvidence" class="ev">
    <!-- 1. THE CORROBORATION. Listed first because it is the gate that does the
         real work: the gallons are believed only because this reading's own
         total reproduces the amount already on the row. -->
    <div v-if="amountEv" class="ev-line">
      <span class="ev-key">Total</span>
      <span :class="['ev-val', amountEv.ok ? 'ev-ok' : 'ev-bad']">
        <svg v-if="amountEv.ok" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>
        <svg v-else width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        {{ amountEv.text }}
      </span>
    </div>

    <!-- 2. THE PRICE, against the band. -->
    <div v-if="meter" class="ev-line ev-line-meter">
      <span class="ev-key">Price</span>
      <div class="ev-meter-wrap">
        <span :class="['ev-cpg', meter.inBand ? 'ev-ok' : 'ev-bad']">{{ cpgText }}</span>
        <div
          class="ev-meter"
          role="img"
          :aria-label="meterLabel"
          :title="meterLabel"
        >
          <!-- The band: the region the fleet's own priced receipts occupy. -->
          <span
            class="ev-band"
            :style="{ left: meter.bandStartPct + '%', width: Math.max(0, meter.bandEndPct - meter.bandStartPct) + '%' }"
          ></span>
          <!-- The reading. Out of band it is red and, when it is off the drawn
               scale entirely, it becomes an arrow pinned at the edge rather than
               a tick pretending to be merely "at the limit". -->
          <span
            :class="['ev-mark', meter.inBand ? 'ev-mark-in' : 'ev-mark-out', meter.clamped ? 'ev-mark-clamped' : '']"
            :style="{ left: meter.valuePct + '%' }"
          ></span>
        </div>
        <span class="ev-scale">
          <span>{{ money(meter.min) }}</span>
          <span class="ev-scale-mid">fleet range</span>
          <span>{{ money(meter.max) }}</span>
        </span>
      </div>
    </div>
    <!-- A price with no band to judge it against. Shown, but never dressed as
         corroborated — the number alone establishes nothing. -->
    <div v-else-if="row.hasCpg" class="ev-line">
      <span class="ev-key">Price</span>
      <span class="ev-val">{{ cpgText }}</span>
    </div>

    <!-- 3. THE TWO SIGNALS THAT ARE REPORTED AND NEVER DECIDE. Both are
         deliberately not gates (see lib/receipt-gallons-recovery.js): the date
         disagreed on 2 of 24 genuine recoveries, and the model's confidence is
         strictly weaker evidence than an exact total. They are here because the
         human is the one judging, and they are visually subordinate because
         acting on them would be a mistake. -->
    <div v-if="row.hasDateMatch || row.hasConfidence || row.ocrVendor" class="ev-soft">
      <span v-if="row.hasDateMatch" :class="['ev-soft-item', row.dateMatches ? '' : 'ev-soft-warn']" :title="dateTitle">
        Date {{ row.dateMatches ? 'agrees' : 'differs' }}<template v-if="row.ocrDate"> ({{ row.ocrDate }})</template>
      </span>
      <span v-if="row.hasConfidence" class="ev-soft-item" title="The scanner's own opinion of its reading. Reported for context only — it never decides a verdict, because the total matching to the cent is far harder evidence than a model's self-assessment.">
        Scanner confidence {{ row.ocrConfidence }}
      </span>
      <span v-if="row.ocrVendor" class="ev-soft-item" title="The vendor name the scanner read off the image. Shown so you can tell at a glance whether it read the right piece of paper.">
        Read “{{ row.ocrVendor }}”
      </span>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { cpgMeter, fmtMoney, fmtCpg, amountEvidence } from '../../../lib/gallonsRecovery'

const props = defineProps({
  // Already normalized by lib/gallonsRecovery — carries the has* presence flags.
  row: { type: Object, required: true },
  band: { type: Object, default: null },
})

const anyEvidence = computed(() =>
  props.row?.hasDelta || props.row?.hasCpg || props.row?.hasDateMatch ||
  props.row?.hasConfidence || !!props.row?.ocrVendor
)

const meter = computed(() => (props.row?.hasCpg ? cpgMeter(props.row.impliedCpg, props.band) : null))

// Pass/fail is the VERDICT's call, not a comparison done here — see
// amountEvidence(). A `recovered` row with a $0.01 delta passed the gate within
// its tolerance and must not be marked with a failure cross.
const amountEv = computed(() => amountEvidence(props.row))
const cpgText = computed(() => fmtCpg(props.row?.impliedCpg))

const meterLabel = computed(() => {
  const m = meter.value
  if (!m) return ''
  const where = m.inBand
    ? `inside this fleet’s usual ${money(m.min)}–${money(m.max)} per gallon`
    : `${m.above ? 'above' : 'below'} this fleet’s usual ${money(m.min)}–${money(m.max)} per gallon`
  return `Implied price ${fmtCpg(m.value)}, ${where}.`
})

const dateTitle = computed(() =>
  props.row?.dateMatches
    ? 'The date read off the receipt matches the date on the expense row.'
    : 'The date read off the receipt differs from the date on the row. Reported, never decisive — on this fleet both disagreements were faint print or a typo on the row, on receipts whose totals matched to the cent.'
)

function money(v) { return fmtMoney(v) }
</script>

<style scoped>
.ev { display: flex; flex-direction: column; gap: 0.25rem; font-size: 0.69rem; line-height: 1.45; }

.ev-line { display: flex; align-items: baseline; gap: 0.4rem; }
.ev-line-meter { align-items: flex-start; }
.ev-key {
  flex: 0 0 auto;
  min-width: 2.6rem;
  color: var(--text-dim);
  font-weight: 600;
}
.ev-val { display: inline-flex; align-items: center; gap: 0.22rem; }
.ev-ok { color: #166534; font-weight: 600; }
.ev-bad { color: #b91c1c; font-weight: 600; }

.ev-meter-wrap { display: flex; flex-direction: column; gap: 0.15rem; min-width: 11rem; flex: 1 1 auto; }
.ev-cpg { font-weight: 700; }

/* The band drawn as a region and the reading as a mark on it. This is the
   difference between reporting "$9.00/gal, band $2.85–$6.78" and showing a
   marker jammed against the right-hand end: the first is arithmetic the reader
   has to do, the second is a glance. */
.ev-meter {
  position: relative;
  height: 7px;
  border-radius: 4px;
  background: repeating-linear-gradient(
    90deg,
    var(--border) 0 4px,
    transparent 4px 8px
  );
}
.ev-band {
  position: absolute;
  top: 0; bottom: 0;
  border-radius: 4px;
  background: #bbf7d0;
}
.ev-mark {
  position: absolute;
  top: -3px;
  width: 3px; height: 13px;
  margin-left: -1.5px;
  border-radius: 2px;
}
.ev-mark-in { background: #166534; }
.ev-mark-out { background: #dc2626; }
/* Off the drawn scale: a triangle pointing off-axis, so "further out than this
   chart goes" doesn't render as "sitting exactly at the limit". */
.ev-mark-clamped {
  width: 0; height: 0;
  margin-left: -5px;
  background: none;
  border-top: 6px solid transparent;
  border-bottom: 6px solid transparent;
  border-left: 7px solid #dc2626;
}
.ev-scale {
  display: flex;
  justify-content: space-between;
  gap: 0.3rem;
  font-size: 0.6rem;
  color: var(--text-dim);
}
.ev-scale-mid { opacity: 0.75; }

.ev-soft {
  display: flex; flex-wrap: wrap; gap: 0.15rem 0.55rem;
  margin-top: 0.1rem;
  font-size: 0.64rem;
  color: var(--text-dim);
}
.ev-soft-item { cursor: help; }
.ev-soft-warn { color: #92400e; }
</style>
