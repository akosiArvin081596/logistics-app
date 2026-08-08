<template>
  <!-- Mounted inside the "Receipts missing gallons" queue card in ExpensesTab.
       Same receipts, one server query (volumelessFuelReceiptRows) — this panel
       adds the REASON each one is or isn't recoverable, which is the half the
       queue could never answer. Super Admin only: both verbs are
       requireRole('Super Admin'), so a dispatcher must never see the door. -->
  <div class="gr" v-if="isSuperAdmin">
    <!-- ONE persistent live region for the whole panel. Persistent because a
         region that is v-if'd into existence alongside its own text is missed by
         several screen readers — the node has to be there before the text
         changes. And exactly one, because a second (the loading strip used to
         carry role="status") double-announces the same run.

         It earns its place here more than on most screens: a run takes up to two
         minutes and then silently swaps the page content. Without this a
         non-sighted admin gets no signal that anything finished. -->
    <p class="gr-sr-only" role="status" aria-live="polite">{{ announcement }}</p>

    <div class="gr-head">
      <div class="gr-head-text">
        <span class="gr-title">Read the gallons off the receipts</span>
        <span class="gr-badge" title="This inspection reads the stored receipt image and proposes a volume. It writes nothing on its own.">read-only</span>
      </div>
      <button
        type="button"
        class="gr-run"
        :disabled="loading"
        :aria-busy="loading ? 'true' : 'false'"
        :title="runTitle"
        @click="run()"
      >
        <span v-if="loading" class="gr-spinner" aria-hidden="true"></span>
        {{ loading ? 'Reading receipts…' : (payload ? 'Run again' : 'Check what can be recovered') }}
      </button>
    </div>

    <!-- Kept short on purpose. The first draft explained the whole mechanism
         here and pushed the actual finding below the fold — on a review surface
         the result has to lead, and the method belongs where someone goes
         looking for it. The two gates are restated per section anyway, in the
         reason the server itself wrote. -->
    <p class="cal-note gr-intro">
      The volume is printed on the receipt the server already stored. This reads it back and proposes
      the gallons — trusting the reading <strong>only</strong> when its own total reproduces the amount
      already on the row <em>and</em> the implied price per gallon lands inside this fleet's normal
      range. Every receipt comes back with a verdict and a reason, including the refusals.
      <!-- Said before the button is pressed, not after: this is the one control
           on the panel that costs money, and the 6-per-15-minutes cap is low
           enough that a surprised user can lock themselves out of it. -->
      <strong>It runs only when you ask</strong> — scanning is billed per receipt and rate-limited, so
      nothing here loads on its own.
    </p>

    <!-- IDLE — a purposeful empty state, matching the queue conventions on this
         tab: say what pressing the button will do, not "no data". -->
    <div v-if="!payload && !loading && !error" class="gr-idle">
      <span class="gr-idle-icon" aria-hidden="true">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
      </span>
      <span>
        Nothing has been read yet. Running this will tell you, receipt by receipt, which volumes can be
        recovered from the stored image and why the rest can't.
      </span>
    </div>

    <!-- LOADING — the duration is stated because the server's own deadline is
         two minutes and a silent two-minute spinner reads as a hang. -->
    <div v-if="loading" class="gr-loading">
      <div class="skeleton skeleton-line"></div>
      <div class="skeleton skeleton-line short"></div>
      <p class="gr-loading-note">
        Reading each receipt image. This can take up to two minutes for a full batch — the panel stays
        on this screen, so you can leave it running.
      </p>
    </div>

    <!-- ERROR — classified, so the two that have a specific remedy say it. -->
    <div v-if="error && !loading" class="gr-error" role="alert">
      <strong>{{ errorTitle }}</strong>
      <span>{{ error }}</span>
      <span v-if="errorHint" class="gr-error-hint">{{ errorHint }}</span>
    </div>

    <template v-if="payload && !loading">
      <!-- THE FINDING. One sentence, composed from what this run actually
           established — today in production that sentence is "all 25 came back
           the same: month closed", which is the single glance the panel exists
           for. -->
      <div class="gr-headline" :class="allClosed ? 'gr-headline-closed' : ''">
        <div class="gr-headline-text">{{ headline }}</div>
        <div v-if="coverage" class="gr-coverage">
          {{ coverage }}
          <!-- The remedy for an over-cap remainder is a WIDER pass, not another
               identical one. The button exists so the sentence above has
               something true to point at; it is absent when the backlog is
               larger than a single pass can hold, because then no button
               finishes the job and offering one would be the same false
               promise in a different shape. -->
          <button
            v-if="coverageDetail.canScanAll"
            type="button"
            class="gr-coverage-btn"
            :disabled="loading"
            :title="`Read all ${coverageDetail.scanAllLimit} receipts in one pass instead of the default ${coverageDetail.examined}. This scans more receipts, so it costs more.`"
            @click="run(coverageDetail.scanAllLimit)"
          >
            Scan all {{ coverageDetail.scanAllLimit }}
          </button>
        </div>
      </div>

      <!-- The chip strip. Filters the sections below; `aria-pressed` rather than
           a link because this narrows the view in place. -->
      <div v-if="chips.length > 1" class="gr-chips" role="group" aria-label="Filter receipts by verdict">
        <button
          v-for="c in chips"
          :key="c.verdict"
          type="button"
          class="gr-chip"
          :class="[`tone-${c.tone}`, { on: focus === c.verdict }]"
          :aria-pressed="focus === c.verdict"
          :title="focus === c.verdict ? 'Showing only these — click to show all again' : `Show only the ${c.count} marked “${c.label}”`"
          @click="toggleFocus(c.verdict)"
        >
          {{ c.label }}
          <span class="gr-chip-n">{{ c.count }}</span>
          <span class="gr-chip-amt">{{ money(c.amount) }}</span>
        </button>
        <button v-if="focus" type="button" class="gr-chip gr-chip-clear" @click="focus = ''">Show all</button>
      </div>

      <!-- The fleet's own price band, stated once. It is the yardstick every
           "price out of range" refusal below is measured against, so a reader
           has to be able to see where it came from. -->
      <p v-if="bandNote" class="gr-band-note">
        <strong>Plausible price band {{ bandRange }}.</strong> {{ bandNote }}
      </p>

      <!-- SECTIONS — one per verdict. The shared reason is hoisted to the
           section header when every row in it says the same thing. -->
      <section v-for="s in visibleSections" :key="s.verdict" class="gr-section" :class="`tone-${s.tone}`">
        <div class="gr-sec-head">
          <span class="gr-sec-label">{{ s.label }}</span>
          <span class="gr-sec-count">{{ s.count }} receipt{{ s.count === 1 ? '' : 's' }}</span>
          <span class="gr-sec-amt">{{ money(s.amount) }}</span>
          <span v-if="s.gallons > 0" class="gr-sec-gal">{{ gallons(s.gallons) }}</span>
          <!-- Never present a closed receipt as actionable — the rule the
               volumeless queue already documents. This is the badge that says
               so at the section level, so it is answered before a reader starts
               scanning rows for a button. -->
          <span v-if="s.group === 'closed'" class="gr-sec-lock" title="Month-end close has finalized these months. The recovery refuses them before it reads anything, so no scanner time is spent on them either.">
            can’t be written
          </span>
        </div>

        <p v-if="s.sharedReason" class="gr-sec-reason">{{ s.sharedReason }}</p>
        <p v-else class="gr-sec-reason gr-sec-reason-dim">{{ s.blurb }}</p>

        <!-- Desktop: a table. Mobile: the same rows as cards. One source list,
             two renderings — the pattern the rest of the admin pages use below
             the md breakpoint. -->
        <div class="gr-table-wrap">
          <table class="gr-table">
            <thead>
              <tr>
                <th v-if="s.actionableCount" class="gr-th-check">
                  <label class="gr-check">
                    <input
                      type="checkbox"
                      :checked="allSelectedIn(s)"
                      :indeterminate.prop="someSelectedIn(s) && !allSelectedIn(s)"
                      :aria-label="`Select all ${s.actionableCount} receipts ready to apply`"
                      @change="toggleSection(s, $event.target.checked)"
                    />
                  </label>
                </th>
                <th>Date</th>
                <th>Truck</th>
                <th>Driver</th>
                <th>Vendor</th>
                <th class="gr-num">Amount</th>
                <th v-if="s.gallons > 0" class="gr-num">Gallons found</th>
                <th v-if="sectionHasEvidence(s)">Evidence</th>
                <th v-if="s.rowsCarryReason">Why</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in s.rows" :key="r.id" :class="{ 'gr-row-closed': r.group === 'closed', 'gr-row-sel': isSelected(r) }">
                <td v-if="s.actionableCount" class="gr-td-check">
                  <!-- The label, not the input, is the hit area: a bare 13px
                       checkbox is under the 24px minimum target size and is
                       genuinely fiddly to hit. -->
                  <label v-if="r.actionable" class="gr-check">
                    <input
                      type="checkbox"
                      :checked="isSelected(r)"
                      :aria-label="`Apply ${gallons(r.proposedGallons)} to the ${money(r.amount)} receipt from ${r.vendor || 'unknown vendor'} on ${ymd(r.localDay)}`"
                      @change="toggleRow(r)"
                    />
                  </label>
                </td>
                <td class="mono">
                  {{ ymd(r.localDay) }}
                  <span v-if="r.group === 'closed'" class="closed-chip" :title="`${r.periodLabel || 'This month'} was finalized by month-end close.`">closed</span>
                  <span v-if="r.written" class="gr-written-chip" title="Written to the expense row by this run.">written</span>
                </td>
                <td class="mono">{{ r.truckUnit || '—' }}</td>
                <td>{{ r.driver || '—' }}</td>
                <td>{{ r.vendor || '—' }}</td>
                <td class="mono gr-num">{{ money(r.amount) }}</td>
                <td v-if="s.gallons > 0" class="mono gr-num">
                  <!-- Absent renders NOTHING, not a dash and not a zero: on a
                       refused row there is no proposal, and "—" would read as
                       "we looked and found none" rather than "we declined to
                       propose one". -->
                  <strong v-if="r.proposedGallons !== null" class="gr-gal">{{ gallons(r.proposedGallons) }}</strong>
                </td>
                <td v-if="sectionHasEvidence(s)" class="gr-ev-cell">
                  <RecoveryEvidence :row="r" :band="payload.cpgBand" />
                </td>
                <td v-if="s.rowsCarryReason" class="gr-why">{{ r.reason }}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- Mobile cards -->
        <ul class="gr-cards">
          <li v-for="r in s.rows" :key="r.id" class="gr-card" :class="{ 'gr-row-closed': r.group === 'closed', 'gr-row-sel': isSelected(r) }">
            <div class="gr-card-top">
              <label v-if="r.actionable" class="gr-card-check">
                <input type="checkbox" :checked="isSelected(r)" @change="toggleRow(r)" />
                <span class="gr-card-check-text">Apply</span>
              </label>
              <span class="mono gr-card-date">
                {{ ymd(r.localDay) }}
                <span v-if="r.group === 'closed'" class="closed-chip">closed</span>
                <span v-if="r.written" class="gr-written-chip">written</span>
              </span>
              <span class="mono gr-card-amt">{{ money(r.amount) }}</span>
            </div>
            <div class="gr-card-who">
              <span class="mono">{{ r.truckUnit || '—' }}</span>
              <span v-if="r.driver">· {{ r.driver }}</span>
            </div>
            <div v-if="r.vendor" class="gr-card-vendor">{{ r.vendor }}</div>
            <div v-if="r.proposedGallons !== null" class="gr-card-gal">
              <strong class="gr-gal">{{ gallons(r.proposedGallons) }}</strong> proposed
            </div>
            <RecoveryEvidence :row="r" :band="payload.cpgBand" class="gr-card-ev" />
            <p v-if="s.rowsCarryReason" class="gr-card-why">{{ r.reason }}</p>
          </li>
        </ul>
      </section>

      <!-- APPLY. Renders only when this run actually produced something
           applicable, so in production today — where every receipt is in a
           closed month — this bar does not exist at all. Nothing is preselected:
           the action names exactly the rows it will write. -->
      <div v-if="applicable.length" class="gr-apply">
        <div class="gr-apply-text">
          <strong>{{ selectedRows.length }} of {{ applicable.length }} selected.</strong>
          <template v-if="selectedRows.length">
            Applying writes {{ gallons(selectedGallons) }} onto {{ selectedRows.length }} expense
            row{{ selectedRows.length === 1 ? '' : 's' }}.
          </template>
          <template v-else>
            Tick the receipts whose evidence you accept. Nothing is written until you do.
          </template>
        </div>
        <div class="gr-apply-actions">
          <button type="button" class="gr-link" :disabled="applying" @click="selectAll">Select all {{ applicable.length }}</button>
          <button type="button" class="gr-link" :disabled="applying || !selectedRows.length" @click="selected.clear()">Clear</button>
          <button
            type="button"
            class="gr-apply-btn"
            :disabled="!selectedRows.length || applying"
            @click="confirmOpen = true"
          >
            {{ applying ? 'Applying…' : `Apply ${selectedRows.length || ''} to the expense rows`.trim() }}
          </button>
        </div>
      </div>
    </template>

    <!-- The write is confirm-gated, on the Mark Paid precedent: it is the one
         action here that changes a finance row, and the summary names the exact
         rows so the confirm cannot be dismissed as a formality. -->
    <ConfirmModal
      :open="confirmOpen"
      title="Write these gallons onto the expense rows?"
      :message="confirmMessage"
      confirm-text="Write the gallons"
      cancel-text="Cancel"
      danger
      @cancel="confirmOpen = false"
      @confirm="apply"
    />
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'
import { useApi } from '../../../composables/useApi'
import { useToast } from '../../../composables/useToast'
import { useAuthStore } from '../../../stores/auth'
import ConfirmModal from '../../shared/ConfirmModal.vue'
import RecoveryEvidence from './RecoveryEvidence.vue'
import { fmtYmd } from '../../../utils/datetime'
import {
  recoveryRows, verdictSections, verdictChips, recoveryHeadline, coverageNote,
  coverageDetail as coverageDetailOf, bandSourceNote, fmtMoney, fmtGallons, isClosed,
} from '../../../lib/gallonsRecovery'

const api = useApi()
const { show: toast } = useToast()
const auth = useAuthStore()

const isSuperAdmin = computed(() => auth.isSuperAdmin)

const payload = ref(null)
const loading = ref(false)
const applying = ref(false)
const error = ref('')
const errorTitle = ref('')
const errorHint = ref('')
const focus = ref('')
const confirmOpen = ref(false)
const selected = ref(new Set())

// The server's own deadline is 120 s and a full batch measured 109 s against
// production data. useApi defaults to a 20 s timeout, which would abort every
// real run and report it as "check your connection" — a network error message
// on a request that was working perfectly. 180 s leaves headroom over the
// server's deadline so the response we surface is always the server's own.
const RUN_TIMEOUT_MS = 180000

const rows = computed(() => recoveryRows(payload.value))
const sections = computed(() => verdictSections(rows.value))
const chips = computed(() => verdictChips(rows.value))
const headline = computed(() => recoveryHeadline(rows.value))
const coverage = computed(() => coverageNote(payload.value, rows.value))
const coverageDetail = computed(() => coverageDetailOf(payload.value, rows.value))
const bandNote = computed(() => bandSourceNote(payload.value?.cpgBand))
const bandRange = computed(() => {
  const b = payload.value?.cpgBand
  return b && b.min != null && b.max != null ? `${fmtMoney(b.min)}–${fmtMoney(b.max)} per gallon` : ''
})
const allClosed = computed(() => rows.value.length > 0 && rows.value.every(isClosed))
const visibleSections = computed(() =>
  focus.value ? sections.value.filter((s) => s.verdict === focus.value) : sections.value
)
const applicable = computed(() => rows.value.filter((r) => r.actionable))
const selectedRows = computed(() => applicable.value.filter((r) => selected.value.has(r.id)))
const selectedGallons = computed(() =>
  Math.round(selectedRows.value.reduce((s, r) => s + (r.proposedGallons ?? 0), 0) * 100) / 100
)

// What the live region says. Deliberately the same facts the sighted user gets
// (the headline and the coverage caveat), not a separate "done" — a screen
// reader user needs the finding, not a notification that a finding exists.
const announcement = computed(() => {
  if (loading.value) return 'Reading receipts. This can take up to two minutes.'
  if (applying.value) return 'Writing the gallons.'
  if (error.value) return `${errorTitle.value} ${error.value} ${errorHint.value}`.trim()
  if (!payload.value) return ''
  return [headline.value, coverage.value].filter(Boolean).join(' ')
})

const runTitle = computed(() =>
  loading.value
    ? 'A run is in progress'
    : 'Reads each stored receipt image and proposes its gallons. Writes nothing. Rate-limited to 6 runs every 15 minutes.'
)

const confirmMessage = computed(() => {
  const n = selectedRows.value.length
  const trucks = [...new Set(selectedRows.value.map((r) => r.truckUnit).filter(Boolean))]
  return [
    `${n} receipt${n === 1 ? '' : 's'} · ${fmtGallons(selectedGallons.value)} · ${fmtMoney(selectedRows.value.reduce((s, r) => s + (r.amount ?? 0), 0))}`,
    trucks.length ? `Truck${trucks.length === 1 ? '' : 's'}: ${trucks.join(', ')}` : '',
    '',
    'This writes the gallons onto the expense rows, which feed fuel economy, cost per mile and investor settlements.',
    'The reading is taken again on the server — the numbers on screen are not sent back — and any receipt whose gallons were entered in the meantime is left untouched.',
  ].filter(Boolean).join('\n')
})

function money(v) { return fmtMoney(v) }
function gallons(v) { return fmtGallons(v) }
// Same formatter the sibling review queues on this tab use, so two lists of the
// same receipts cannot print their dates differently.
function ymd(v) { return fmtYmd(v) }

// A section shows the evidence column only when at least one of its rows
// actually carries evidence, so a column of blanks never appears on the
// verdicts decided before anything was read (a closed month, a missing file).
function sectionHasEvidence(s) {
  return s.rows.some((r) => r.hasGallons || r.hasCpg || r.hasDelta || r.hasDateMatch || r.hasConfidence)
}

function isSelected(r) { return selected.value.has(r.id) }
function toggleRow(r) {
  const next = new Set(selected.value)
  next.has(r.id) ? next.delete(r.id) : next.add(r.id)
  selected.value = next
}
function allSelectedIn(s) {
  const act = s.rows.filter((r) => r.actionable)
  return act.length > 0 && act.every((r) => selected.value.has(r.id))
}
function someSelectedIn(s) {
  return s.rows.some((r) => r.actionable && selected.value.has(r.id))
}
function toggleSection(s, on) {
  const next = new Set(selected.value)
  for (const r of s.rows) {
    if (!r.actionable) continue
    on ? next.add(r.id) : next.delete(r.id)
  }
  selected.value = next
}
function selectAll() {
  selected.value = new Set(applicable.value.map((r) => r.id))
}
function toggleFocus(v) { focus.value = focus.value === v ? '' : v }

function clearError() { error.value = ''; errorTitle.value = ''; errorHint.value = '' }

// Errors are classified rather than dumped: three of them have a specific
// remedy, and "Request failed (429)" tells an admin nothing about what to do.
function setError(err, verb) {
  const status = err?.status
  const code = err?.code
  if (code === 'TIMEOUT') {
    errorTitle.value = 'The run took too long to come back.'
    error.value = 'The server keeps working on a batch for up to two minutes.'
    errorHint.value = 'Wait a moment and run it again — anything it already read is picked up on the next pass.'
  } else if (status === 429) {
    errorTitle.value = 'Rate limit reached.'
    error.value = 'This inspection is capped at 6 runs every 15 minutes because each pass is billed per receipt.'
    errorHint.value = 'Try again shortly.'
  } else if (status === 503 && code === 'RECOVERY_DISABLED') {
    errorTitle.value = 'Writing is switched off on this server.'
    error.value = err?.message || 'Recovery ships dormant.'
    errorHint.value = 'The inspection above still works — set FUEL_GALLONS_RECOVERY_ENABLED to let it write.'
  } else if (status === 503) {
    errorTitle.value = 'The receipt scanner is not configured.'
    error.value = 'Reading a receipt image needs the document-scanning key set on this server.'
    errorHint.value = ''
  } else if (status === 403) {
    errorTitle.value = 'Refused.'
    error.value = err?.message || 'This action is available to Super Admins only.'
    errorHint.value = ''
  } else if (status === 409) {
    errorTitle.value = 'A run is already in progress.'
    error.value = 'Another admin is applying a batch right now.'
    errorHint.value = 'Wait for it to finish, then run the inspection again to see the result.'
  } else {
    errorTitle.value = `Could not ${verb} the receipts.`
    error.value = err?.message || 'Something went wrong.'
    errorHint.value = ''
  }
}

// `limit` is only ever sent when the user explicitly asked for a wider pass.
// Omitting it leaves the server on its own default (25) rather than the client
// pinning a number that would then need updating in two places.
async function run(limit = null) {
  if (loading.value) return
  loading.value = true
  clearError()
  try {
    const url = limit ? `/api/admin/fuel-gallons-recovery?limit=${encodeURIComponent(limit)}` : '/api/admin/fuel-gallons-recovery'
    const data = await api.get(url, { timeout: RUN_TIMEOUT_MS })
    payload.value = data
    // A previous selection cannot survive a fresh reading: the same expense id
    // may come back with a different verdict, and carrying a tick across that
    // would let someone apply a row whose evidence changed under them.
    selected.value = new Set()
    focus.value = ''
    if (data?.deadlineHit) {
      toast('The batch ran out of time before reading every receipt — run it again to pick up the rest.', 'warning')
    }
  } catch (err) {
    setError(err, 'read')
  } finally {
    loading.value = false
  }
}

async function apply() {
  confirmOpen.value = false
  const ids = selectedRows.value.map((r) => r.id)
  if (!ids.length) return
  applying.value = true
  clearError()
  try {
    const data = await api.post('/api/admin/fuel-gallons-recovery/apply', { ids }, { timeout: RUN_TIMEOUT_MS })
    payload.value = data
    selected.value = new Set()
    focus.value = ''
    const n = Number(data?.written) || 0
    // Reports what the SERVER said it wrote, never the count that was sent. The
    // two can legitimately differ — a period can finalize or someone can key the
    // gallons by hand while the batch is in flight, and the server rewrites
    // those verdicts rather than counting them as recovered.
    if (n > 0) toast(`Wrote gallons onto ${n} receipt${n === 1 ? '' : 's'}.`, 'success')
    else toast('Nothing was written — every selected receipt was declined on the second check. See the verdicts below.', 'warning')
  } catch (err) {
    setError(err, 'apply')
  } finally {
    applying.value = false
  }
}
</script>

<style scoped>
/* Owns the review card it is mounted in, so no frame of its own — a second
   bordered box inside the first reads as two problems rather than one. */
.gr { display: block; }

/* Visually hidden, still announced. The standard clip pattern — `display:none`
   and `visibility:hidden` both remove it from the accessibility tree, which
   would silence the live region entirely. */
.gr-sr-only {
  position: absolute;
  width: 1px; height: 1px;
  margin: -1px; padding: 0;
  overflow: hidden;
  clip: rect(0 0 0 0);
  clip-path: inset(50%);
  white-space: nowrap;
  border: 0;
}

.gr-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  flex-wrap: wrap;
  margin-bottom: 0.5rem;
}
.gr-head-text { display: inline-flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
.gr-title { font-size: 0.82rem; font-weight: 700; }
.gr-badge {
  display: inline-flex; align-items: center;
  padding: 1px 7px;
  font-size: 0.6rem; font-weight: 700;
  text-transform: uppercase; letter-spacing: 0.04em;
  border-radius: 10px;
  border: 1px solid var(--border);
  color: var(--text-dim);
  cursor: help;
}

.gr-run {
  display: inline-flex; align-items: center; gap: 0.4rem;
  padding: 0.42rem 0.8rem;
  font-family: inherit; font-size: 0.75rem; font-weight: 600;
  border-radius: 6px;
  border: 1px solid #92400e;
  background: #92400e;
  color: #fff;
  cursor: pointer;
  transition: opacity 0.15s;
}
.gr-run:hover:not(:disabled) { opacity: 0.88; }
.gr-run:disabled { opacity: 0.6; cursor: default; }
.gr-run:focus-visible { outline: 2px solid #92400e; outline-offset: 2px; }
.gr-spinner {
  width: 11px; height: 11px;
  border: 2px solid rgba(255,255,255,0.35);
  border-top-color: #fff;
  border-radius: 50%;
  animation: gr-spin 0.7s linear infinite;
}
@keyframes gr-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .gr-spinner { animation-duration: 2.4s; } }

.gr-intro { margin-bottom: 0.75rem; }

.gr-idle {
  display: flex; align-items: flex-start; gap: 0.55rem;
  padding: 0.7rem 0.8rem;
  border: 1px dashed var(--border);
  border-radius: var(--radius);
  font-size: 0.72rem; line-height: 1.5;
  color: var(--text-dim);
}
.gr-idle-icon { color: var(--text-dim); flex-shrink: 0; margin-top: 1px; }

.gr-loading .skeleton-line { height: 12px; border-radius: 4px; margin-bottom: 0.45rem; }
.gr-loading .skeleton-line.short { width: 55%; }
.gr-loading-note { font-size: 0.72rem; color: var(--text-dim); margin-top: 0.5rem; line-height: 1.5; }

.gr-error {
  display: flex; flex-direction: column; gap: 0.2rem;
  padding: 0.7rem 0.8rem;
  border: 1px solid #fecaca;
  background: #fef2f2;
  border-radius: var(--radius);
  font-size: 0.73rem; line-height: 1.5;
  color: #991b1b;
}
.gr-error strong { color: #7f1d1d; }
.gr-error-hint { color: #b91c1c; }

/* The finding. Amber by default (there is work), grey when everything came back
   closed — because then it is a statement of fact, not a call to action, and
   dressing it as work would send someone looking for a button that must not
   exist. */
.gr-headline {
  padding: 0.7rem 0.8rem;
  border-radius: var(--radius);
  border: 1px solid #fde68a;
  background: #fffbeb;
  color: #78350f;
  font-size: 0.76rem; line-height: 1.55;
  margin-bottom: 0.7rem;
}
.gr-headline-closed {
  border-color: var(--border);
  background: var(--bg);
  color: var(--text-dim);
}
.gr-headline-text { font-weight: 600; }
.gr-coverage { margin-top: 0.3rem; font-size: 0.71rem; opacity: 0.85; font-weight: 400; }
.gr-coverage-btn {
  margin-left: 0.35rem;
  padding: 0.12rem 0.45rem;
  font-family: inherit; font-size: 0.68rem; font-weight: 600;
  border-radius: 5px;
  border: 1px solid currentColor;
  background: transparent;
  color: inherit;
  cursor: pointer;
  white-space: nowrap;
}
.gr-coverage-btn:disabled { opacity: 0.5; cursor: default; }
.gr-coverage-btn:focus-visible { outline: 2px solid currentColor; outline-offset: 1px; }

.gr-chips { display: flex; flex-wrap: wrap; gap: 0.4rem; margin-bottom: 0.7rem; }
.gr-chip {
  display: inline-flex; align-items: center; gap: 0.35rem;
  padding: 0.3rem 0.55rem;
  font-family: inherit; font-size: 0.7rem; font-weight: 600;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--text);
  cursor: pointer;
}
.gr-chip:focus-visible { outline: 2px solid #92400e; outline-offset: 1px; }
.gr-chip-n {
  display: inline-flex; align-items: center; justify-content: center;
  min-width: 17px; padding: 0 4px;
  border-radius: 9px;
  background: rgba(0,0,0,0.06);
  font-size: 0.65rem; font-weight: 700;
}
.gr-chip-amt { font-size: 0.65rem; color: var(--text-dim); font-weight: 500; }
.gr-chip.on { border-color: #92400e; background: #fef3c7; color: #78350f; }
.gr-chip.on .gr-chip-amt { color: #92400e; }
.gr-chip-clear { font-weight: 500; color: var(--text-dim); }

/* Tone is colour only — grouping and actionability are decided in the lib. */
.gr-chip.tone-good { border-color: #86efac; background: #f0fdf4; color: #166534; }
.gr-chip.tone-good.on { border-color: #16a34a; background: #dcfce7; }
.gr-chip.tone-amber { border-color: #fde68a; background: #fffbeb; color: #92400e; }
.gr-chip.tone-refused { border-color: #fecaca; background: #fef2f2; color: #991b1b; }
.gr-chip.tone-refused.on { border-color: #dc2626; background: #fee2e2; color: #7f1d1d; }
.gr-chip.tone-muted { color: var(--text-dim); }

.gr-band-note {
  font-size: 0.71rem; line-height: 1.5;
  color: var(--text-dim);
  margin: 0 0 0.8rem;
  max-width: 78ch;
}
.gr-band-note strong { color: var(--text); font-weight: 600; }

.gr-section {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 0.7rem 0.8rem;
  margin-bottom: 0.7rem;
  background: var(--surface);
}
.gr-section.tone-good { border-color: #86efac; background: #f0fdf4; }
.gr-section.tone-amber { border-color: #fde68a; background: #fffbeb; }
.gr-section.tone-refused { border-color: #fecaca; background: #fef2f2; }
/* A closed section is quiet on purpose: there is nothing to do in it. It is
   still fully legible — the figures are the reason it is listed at all. */
.gr-section.tone-muted { background: var(--bg); }

.gr-sec-head {
  display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap;
  margin-bottom: 0.35rem;
}
.gr-sec-label { font-size: 0.76rem; font-weight: 700; }
.gr-sec-count, .gr-sec-amt, .gr-sec-gal { font-size: 0.7rem; color: var(--text-dim); }
.gr-sec-amt { font-weight: 600; color: var(--text); }
.gr-sec-gal { font-weight: 600; color: #166534; }
.gr-sec-lock {
  margin-left: auto;
  padding: 1px 7px;
  font-size: 0.6rem; font-weight: 700;
  text-transform: uppercase; letter-spacing: 0.04em;
  border-radius: 10px;
  border: 1px solid var(--border);
  color: var(--text-dim);
  cursor: help;
}
.gr-sec-reason {
  font-size: 0.72rem; line-height: 1.55;
  color: var(--text);
  margin: 0 0 0.6rem;
  max-width: 78ch;
}
.gr-sec-reason-dim { color: var(--text-dim); }

.gr-table-wrap { overflow-x: auto; }
.gr-table { width: 100%; border-collapse: collapse; font-size: 0.72rem; }
.gr-table th {
  text-align: left;
  font-weight: 600;
  color: var(--text-dim);
  padding: 0.3rem 0;
  border-bottom: 1px solid var(--border);
  white-space: nowrap;
}
.gr-table td {
  padding: 0.38rem 0;
  border-bottom: 1px solid var(--border);
  vertical-align: top;
}
/* The gap lives on the LEFT of every cell after the first, not on the right of
   each. A right-padding model plus `.gr-num { padding-right: 0 }` — needed to
   keep a right-aligned figure flush with its header — left the numeric column
   touching the next one, and "Gallons found" ran straight into "Evidence". */
.gr-table th + th, .gr-table td + td { padding-left: 0.75rem; }
.gr-table tr:last-child td { border-bottom: 0; }
.gr-num { text-align: right; }
.gr-th-check, .gr-td-check { width: 2rem; }

/* Target size. A native checkbox renders ~13px, under the 24px minimum, so the
   label supplies the hit area and the input is centred inside it. Applies on
   desktop too — this is a pointer-accuracy fix, not a phone-only one. */
.gr-check {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 24px;
  min-height: 24px;
  margin: -4px 0;
  cursor: pointer;
}
.gr-check input { width: 15px; height: 15px; cursor: pointer; }
.gr-row-closed td { color: var(--text-dim); }
.gr-row-sel { background: rgba(22,163,74,0.07); }
.gr-gal { color: #166534; }
.gr-why { color: var(--text-dim); line-height: 1.5; min-width: 20ch; }
.gr-ev-cell { min-width: 15rem; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }

.closed-chip {
  display: inline-block;
  margin-left: 0.35rem;
  padding: 0 5px;
  font-size: 0.6rem; font-weight: 700;
  line-height: 1.5;
  text-transform: uppercase; letter-spacing: 0.04em;
  border-radius: 4px;
  vertical-align: middle;
  border: 1px solid var(--border);
  color: var(--text-dim);
  cursor: help;
}
.gr-written-chip {
  display: inline-block;
  margin-left: 0.35rem;
  padding: 0 5px;
  font-size: 0.6rem; font-weight: 700;
  line-height: 1.5;
  text-transform: uppercase; letter-spacing: 0.04em;
  border-radius: 4px;
  vertical-align: middle;
  border: 1px solid #86efac;
  background: #dcfce7;
  color: #166534;
}

/* Mobile cards — hidden on desktop, replace the table below md. */
.gr-cards { display: none; list-style: none; padding: 0; margin: 0; }

.gr-apply {
  display: flex; align-items: center; justify-content: space-between;
  gap: 0.75rem; flex-wrap: wrap;
  padding: 0.7rem 0.8rem;
  border: 1px solid #86efac;
  background: #f0fdf4;
  border-radius: var(--radius);
}
.gr-apply-text { font-size: 0.73rem; line-height: 1.5; color: #166534; max-width: 60ch; }
.gr-apply-text strong { color: #14532d; }
.gr-apply-actions { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
.gr-link {
  /* Padded to clear the 24px minimum target size — as a bare text button this
     measured 17px high. */
  display: inline-flex; align-items: center;
  min-height: 24px;
  background: none; border: 0; padding: 0 0.25rem;
  font-family: inherit; font-size: 0.71rem; font-weight: 600;
  color: #166534; cursor: pointer; text-decoration: underline;
}
.gr-link:focus-visible { outline: 2px solid #166534; outline-offset: 1px; border-radius: 3px; }
.gr-link:disabled { opacity: 0.45; cursor: default; text-decoration: none; }
.gr-apply-btn {
  padding: 0.42rem 0.8rem;
  font-family: inherit; font-size: 0.75rem; font-weight: 600;
  border-radius: 6px;
  border: 1px solid #166534;
  background: #166534;
  color: #fff;
  cursor: pointer;
}
.gr-apply-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.gr-apply-btn:focus-visible { outline: 2px solid #14532d; outline-offset: 2px; }

@media (max-width: 767px) {
  .gr-table-wrap { display: none; }
  .gr-cards { display: block; }
  .gr-card {
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
    padding: 0.6rem 0.7rem;
    margin-bottom: 0.5rem;
    font-size: 0.74rem;
  }
  .gr-card:last-child { margin-bottom: 0; }
  .gr-card.gr-row-closed { background: var(--bg); color: var(--text-dim); }
  .gr-card-top { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
  .gr-card-date { font-weight: 600; }
  .gr-card-amt { margin-left: auto; font-weight: 700; }
  .gr-card-check {
    display: inline-flex; align-items: center; gap: 0.3rem;
    min-height: 24px;
    font-size: 0.68rem; font-weight: 600; color: #166534;
    cursor: pointer;
  }
  .gr-card-check input { width: 15px; height: 15px; }
  .gr-card-who { margin-top: 0.2rem; font-size: 0.7rem; color: var(--text-dim); }
  .gr-card-vendor { margin-top: 0.1rem; font-size: 0.7rem; }
  .gr-card-gal { margin-top: 0.3rem; font-size: 0.72rem; }
  .gr-card-ev { margin-top: 0.4rem; }
  .gr-card-why { margin: 0.4rem 0 0; font-size: 0.7rem; line-height: 1.5; color: var(--text-dim); }
  .gr-apply { flex-direction: column; align-items: stretch; }
  .gr-apply-actions { justify-content: space-between; }
  .gr-apply-btn { flex: 1 1 auto; }
}
</style>
