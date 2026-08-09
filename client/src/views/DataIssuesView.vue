<template>
  <div class="admin-page issues-page">
    <div class="page-header">
      <h2>Data Issues</h2>
      <p class="page-sub">
        Checks that run against the fleet's own data &mdash; duplicate receipts, rate cons that never
        became a load, documents that failed to render, GPS with nowhere to go, and whether the fuel
        range figure can be trusted. Each one reports separately: a check that
        <strong>couldn't run</strong> says so, and never counts as all&nbsp;clear.
      </p>
    </div>

    <div v-if="loading" class="loading-state">
      <div class="skeleton skeleton-card" v-for="i in 4" :key="i"></div>
    </div>

    <!-- Page-level failure is reserved for "every check failed", which is a
         session or network problem rather than five coincidences. A single
         check failing degrades inside its own section instead of blanking the
         page — that is the whole point of per-queue availability. -->
    <template v-else-if="loadFailed">
      <div class="error-state">
        <div class="error-title">Could not load any of the checks</div>
        <div class="error-msg">{{ firstError || 'Something went wrong — try again.' }}</div>
        <button class="btn btn-primary" @click="loadAll">Retry</button>
      </div>
    </template>

    <template v-else>
      <!-- Queue bar. Lifted from the Fuel Logs review bar so a queue of things
           to look at reads identically wherever it appears in this app: amber
           when focused, neutral outline when not. Clicking one narrows the page
           to that check. -->
      <div class="issue-bar">
        <button
          v-for="t in queueToggles"
          :key="t.key"
          type="button"
          :style="toggleStyle(t.key)"
          :aria-pressed="String(focus === t.key)"
          :title="focus === t.key ? `Showing only: ${t.label}` : `Show only: ${t.label}`"
          @click="toggleFocus(t.key)"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="margin-right:0.35rem;" aria-hidden="true"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
          {{ t.label }} {{ t.countText }}
        </button>
        <span v-if="clearText" class="issue-clear">{{ clearText }}</span>
        <span v-if="unavailableText" class="issue-unavailable" :title="unavailableTitle">{{ unavailableText }}</span>
      </div>

      <!-- ================= 1. Duplicate receipts ================= -->
      <section v-if="visible('duplicates')" class="section">
        <div class="section-title">
          <div class="section-icon icon-amber">&#128203;</div>
          Duplicate receipts
          <span class="section-sub">{{ Q.duplicates.blurb }}</span>
        </div>

        <QueueStatus
          :state="st.duplicates"
          :clear="Q.duplicates.clear"
          :empty="dupGroups.length === 0"
          :established="established('duplicates')"
          @retry="loadDuplicates"
        />

        <template v-if="answered('duplicates') && dupGroups.length">
          <!-- The split is the headline, never one summed number: a group can
               hold one receipt in an open month and one in a month that has
               already been finalized, and only the first is work. -->
          <div class="rollup">
            <div class="rollup-card">
              <span class="rollup-label">Booked twice</span>
              <span class="rollup-value mono">{{ money(dupSummary?.excessAmount) }}</span>
              <span class="rollup-note">excess &mdash; every copy after the first</span>
            </div>
            <div class="rollup-card">
              <span class="rollup-label">Receipts</span>
              <span class="rollup-value">
                <span class="split-fix">{{ dupCounts.actionable }} to fix</span>
                <span v-if="dupCounts.closed" class="split-sep">&middot;</span>
                <span v-if="dupCounts.closed" class="split-closed">{{ dupCounts.closed }} closed</span>
              </span>
              <span class="rollup-note">
                across {{ dupSummary?.groupCount }} group<template v-if="dupSummary?.groupCount !== 1">s</template>
                <template v-if="dupSummary?.truncated"> &mdash; showing the largest {{ dupSummary.shown }}</template>
              </span>
            </div>
            <div class="rollup-card">
              <span class="rollup-label">Confidence</span>
              <span class="rollup-value conf-row">
                <span v-if="dupSummary?.byConfidence.high" class="conf conf-high">{{ dupSummary.byConfidence.high }} high</span>
                <span v-if="dupSummary?.byConfidence.medium" class="conf conf-medium">{{ dupSummary.byConfidence.medium }} medium</span>
                <span v-if="dupSummary?.byConfidence.low" class="conf conf-low">{{ dupSummary.byConfidence.low }} low</span>
              </span>
              <span class="rollup-note">how much the two rows agree about</span>
            </div>
          </div>

          <p class="read-only-note">
            <strong>Nothing here can be fixed from this page.</strong> There is no void, merge or delete
            behind this check &mdash; it only reports. Open the receipt in Expenses to decide what to do
            with it.
          </p>

          <div v-for="g in dupGroups" :key="g.key" class="dup-group" :class="{ 'dup-closed': g.allClosed }">
            <div class="dup-head">
              <span class="dup-amount mono">{{ money(g.amount) }}</span>
              <span class="dup-times">&times;{{ g.rows.length }}</span>
              <span class="dup-where">
                {{ g.truckUnit || '—' }}
                <template v-if="g.driver"> &middot; {{ g.driver }}</template>
                &middot; {{ fmtDate(g.localDay) }}
              </span>
              <span :class="['conf', 'conf-' + g.confidence]">{{ g.confidence }}</span>
              <span class="dup-excess mono" :title="'Excess booked by this group'">+{{ money(g.excessAmount) }}</span>
              <span
                v-if="g.allClosed"
                class="closed-chip"
                :title="`Every receipt in this group sits in a month that month-end close has finalized.`"
              >all closed</span>
            </div>
            <div v-if="g.reasons.length" class="dup-reasons">{{ g.reasons.join(' · ') }}</div>
            <table class="data-table dup-table">
              <thead>
                <tr>
                  <th scope="col">Expense</th>
                  <th scope="col">Date</th>
                  <th scope="col">Type</th>
                  <th scope="col">Vendor</th>
                  <th scope="col" class="num">Gallons</th>
                  <th scope="col" class="num">Amount</th>
                  <th scope="col" class="action-head"></th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="r in g.rows" :key="r.id" :class="{ 'row-locked': r.locked === true }">
                  <td class="mono">#{{ r.id }}</td>
                  <td>
                    {{ fmtDate(r.localDay) }}
                    <span
                      v-if="r.locked === true"
                      class="closed-chip"
                      :title="`${r.periodLabel || 'This month'} was finalized by month-end close, so this receipt can no longer be edited.`"
                    >closed</span>
                  </td>
                  <td class="dim">{{ r.type || '—' }}</td>
                  <td class="dim">{{ r.vendor || '—' }}</td>
                  <td class="num">{{ r.gallons ? r.gallons.toFixed(2) : '—' }}</td>
                  <td class="num mono">{{ money(r.amount) }}</td>
                  <td class="action-cell">
                    <button
                      type="button"
                      class="action-btn act-open"
                      :title="r.locked === true
                        ? `${r.periodLabel || 'This month'} is closed — open it in Expenses for reference.`
                        : 'Open this receipt in Expenses'"
                      @click="openExpense(r)"
                    >Open in Expenses</button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </template>
      </section>

      <!-- ================= 2. Rate-con reconciliation ================= -->
      <section v-if="visible('ratecon')" class="section">
        <div class="section-title">
          <div class="section-icon icon-blue">&#128231;</div>
          Rate cons with no load
          <span class="section-sub">{{ Q.ratecon.blurb }}</span>
        </div>

        <!-- ⚠️ ON DEMAND, DELIBERATELY. This endpoint opens IMAP against the
             production mailbox and sweeps the last N days of mail on every call.
             Auto-running it on mount would sweep the live mailbox on every visit
             to this page, including every back-navigation. It does NOT consume
             the once-per-load alert (the GET never stamps alerted_at), so
             browsing is safe — it is just not free. -->
        <div class="manual-run">
          <div class="manual-copy">
            <strong>Not checked automatically.</strong> {{ RATECON_COST_NOTE }}
          </div>
          <button
            type="button"
            class="btn btn-primary"
            :disabled="st.ratecon.status === 'loading'"
            @click="loadRatecon"
          >{{ st.ratecon.status === 'loading' ? 'Checking the mailbox…' : (st.ratecon.status === 'idle' ? 'Run this check' : 'Check again') }}</button>
        </div>

        <QueueStatus
          :state="st.ratecon"
          :clear="Q.ratecon.clear"
          idle-text="Nothing checked yet."
          :empty="(ratecon?.missing.length || 0) === 0"
          :established="established('ratecon')"
          @retry="loadRatecon"
        />

        <template v-if="answered('ratecon') && ratecon">
          <div class="scan-meta">
            Scanned <strong>{{ ratecon.scanned }}</strong> inbound message<template v-if="ratecon.scanned !== 1">s</template>
            over {{ ratecon.windowDays }} days in <span class="mono">{{ ratecon.mailbox }}</span>.
            <template v-if="ratecon.selfSentSkipped">
              Skipped <strong>{{ ratecon.selfSentSkipped }}</strong> message<template v-if="ratecon.selfSentSkipped !== 1">s</template>
              we sent ourselves.
            </template>
            <template v-if="ratecon.retired.length">
              Closed {{ ratecon.retired.length }} stale alert<template v-if="ratecon.retired.length !== 1">s</template>.
            </template>
            <span v-if="!ratecon.enabled" class="warn-inline" title="The scheduled 6-hourly sweep is off, so nothing is watching this between manual runs.">
              Scheduled sweep is off.
            </span>
          </div>

          <table v-if="ratecon.missing.length" class="data-table">
            <thead>
              <tr>
                <th scope="col">Load number</th>
                <th scope="col">Email subject</th>
                <th scope="col">Received</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="m in ratecon.missing" :key="m.loadNumber">
                <td class="mono strong">{{ m.loadNumber }}</td>
                <td class="dim subject-cell">{{ m.subject || '—' }}</td>
                <td class="dim">{{ m.date || '—' }}</td>
              </tr>
            </tbody>
          </table>
        </template>
      </section>

      <!-- ================= 3. Onboarding document failures ================= -->
      <section v-if="visible('onboarding')" class="section">
        <div class="section-title">
          <div class="section-icon icon-violet">&#128196;</div>
          Onboarding documents that failed to render
          <span class="section-sub">{{ Q.onboarding.blurb }}</span>
        </div>

        <QueueStatus
          :state="st.onboarding"
          :clear="Q.onboarding.clear"
          :empty="onboardingRows.length === 0"
          :established="established('onboarding')"
          @retry="loadOnboarding"
        />

        <table v-if="answered('onboarding') && onboardingRows.length" class="data-table">
          <thead>
            <tr>
              <th scope="col">Document</th>
              <th scope="col">Signer</th>
              <th scope="col">Why it failed</th>
              <th scope="col">First seen</th>
              <th scope="col" class="action-head"></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="f in onboardingRows" :key="f.alertKey">
              <td>
                <div class="strong">{{ f.docName || f.docKey }}</div>
                <div class="dim tiny mono">{{ f.docKey }}</div>
              </td>
              <td>
                <div class="dim">{{ f.scope === 'investor-application' ? 'Investor' : 'Driver' }} #{{ f.ownerId }}</div>
                <span
                  v-if="f.hasStoredSignature === false"
                  class="closed-chip"
                  title="No signature is stored for this document, so there is nothing to re-render from."
                >no signature</span>
              </td>
              <td class="dim">{{ f.signingError || f.reason || '—' }}</td>
              <td class="dim">{{ fmtWhen(f.firstSeen) }}</td>
              <td class="action-cell">
                <button
                  v-if="f.regeneratable"
                  type="button"
                  class="action-btn act-regen"
                  :disabled="busy === f.alertKey || !!regenBlocked(f)"
                  :title="regenBlocked(f) || 'Re-render this document from the signature already on file'"
                  @click="regenerate(f)"
                >{{ busy === f.alertKey ? 'Working…' : 'Regenerate' }}</button>
                <span v-else class="dim tiny">{{ regenBlocked(f) }}</span>
              </td>
            </tr>
          </tbody>
        </table>
      </section>

      <!-- ================= 4. Linxup unlinked positions ================= -->
      <section v-if="visible('linxup')" class="section">
        <div class="section-title">
          <div class="section-icon icon-blue">&#128225;</div>
          GPS positions not tied to a driver
          <span class="section-sub">{{ Q.linxup.blurb }}</span>
        </div>

        <!-- No `inconclusive` text: this section renders its own, fuller
             explanation of why the counter isn't saying anything yet. -->
        <QueueStatus
          :state="st.linxup"
          :clear="Q.linxup.clear"
          :empty="(linxup?.unlinked || 0) === 0"
          :established="established('linxup')"
          @retry="loadLinxup"
        />

        <template v-if="answered('linxup') && linxup">
          <!-- ⚠️ This is an in-memory counter that resets on restart, not a
               backlog you can open. A bare 0 is ambiguous between "nothing
               unlinked", "just restarted" and "the feed isn't running at all",
               so say which of those we are actually looking at. -->
          <div class="rollup">
            <div class="rollup-card">
              <span class="rollup-label">Unattributed positions</span>
              <span class="rollup-value mono">{{ linxup.meaningful ? linxup.unlinked : '—' }}</span>
              <span class="rollup-note">since the server last restarted</span>
            </div>
            <div class="rollup-card">
              <span class="rollup-label">Feed</span>
              <span class="rollup-value">
                <span :class="['status-pill', linxup.ingesting ? 'st-paid' : 'st-owed']">
                  {{ linxup.ingesting ? 'ingesting' : (linxup.hasToken ? 'dormant' : 'not configured') }}
                </span>
              </span>
              <span class="rollup-note">
                <template v-if="!linxup.hasToken">No webhook token set.</template>
                <template v-else-if="!linxup.enabled">Token set; writes are switched off.</template>
                <template v-else>Speed in {{ linxup.speedUnit || 'mph' }}.</template>
              </span>
            </div>
            <div class="rollup-card">
              <span class="rollup-label">Last message</span>
              <span class="rollup-value small">{{ fmtWhen(linxup.lastReceived) || 'never' }}</span>
              <span class="rollup-note">
                <template v-if="linxup.lastWritten">last written {{ fmtWhen(linxup.lastWritten) }}</template>
                <template v-else>nothing written yet</template>
              </span>
            </div>
          </div>

          <p v-if="!linxup.meaningful" class="read-only-note">
            <strong>This count isn't saying anything yet.</strong>
            <template v-if="!linxup.hasToken">
              No <span class="mono">LINXUP_WEBHOOK_TOKEN</span> is configured, so the webhook refuses every
              push and nothing has been counted.
            </template>
            <template v-else>
              No Linxup message has arrived since this server started, so a zero here is the counter's
              starting value rather than a clean bill of health.
            </template>
          </p>
          <p v-else-if="linxup.unlinked > 0" class="read-only-note">
            A position counts here when it resolves no driver &mdash; which happens when the truck's device
            id isn't linked in <strong>Truck Database</strong>, <em>and</em> when a linked truck has no
            active driver assignment. Check both before assuming it's a linkage problem.
          </p>

          <div v-if="linxup.lastError" class="err-inline">Last error: {{ linxup.lastError }}</div>

          <table v-if="linxup.messageCounts.length" class="data-table compact">
            <thead>
              <tr><th scope="col">Message type</th><th scope="col" class="num">Received</th></tr>
            </thead>
            <tbody>
              <tr v-for="m in linxup.messageCounts" :key="m.type">
                <td class="mono">{{ m.type }}</td>
                <td class="num">{{ m.count.toLocaleString('en-US') }}</td>
              </tr>
            </tbody>
          </table>
        </template>
      </section>

      <!-- ================= 5. Fuel range verification ================= -->
      <section v-if="visible('fuelverify')" class="section">
        <div class="section-title">
          <div class="section-icon icon-amber">&#9981;</div>
          Fuel range accuracy
          <span class="section-sub">{{ Q.fuelverify.blurb }}</span>
        </div>

        <!-- Same as Linxup: the "sweep has never run" note below is fuller than
             a one-liner here would be. -->
        <QueueStatus
          :state="st.fuelverify"
          :clear="Q.fuelverify.clear"
          :empty="verifyRows.length === 0"
          :established="established('fuelverify')"
          @retry="loadVerify"
        />

        <template v-if="answered('fuelverify')">
          <p v-if="verifyPayload && !verifyPayload.sweepHasRun" class="read-only-note">
            <strong>The fuel-event sweep has never run</strong>, so there is no fill history to backtest
            against. Every truck below reads as unmeasured &mdash; that is the sweep being off, not a
            clean result.
          </p>

          <table v-if="verifyRows.length" class="data-table">
            <thead>
              <tr>
                <th scope="col">Truck</th>
                <th scope="col" class="num">Tank</th>
                <th scope="col" class="num">MPG</th>
                <th scope="col" class="num">Panel shows</th>
                <th scope="col" class="num">History says</th>
                <th scope="col">Verdict</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="t in verifyRows" :key="t.vehicleId">
                <td>
                  <div class="strong">{{ t.unitNumber }}</div>
                  <div v-if="t.assignedDriver" class="dim tiny">{{ t.assignedDriver }}</div>
                </td>
                <td class="num mono">
                  {{ t.tankGallons !== null ? t.tankGallons + ' gal' : '—' }}
                  <span v-if="t.tankSource === 'default'" class="closed-chip" title="No tank size is set on this truck — the range is running on the 200 gal fleet default.">default</span>
                </td>
                <td class="num mono">
                  {{ t.mpg !== null ? t.mpg : '—' }}
                  <span class="dim tiny">{{ t.mpgSource === 'receipts' ? 'receipts' : 'est' }}</span>
                </td>
                <td class="num mono">{{ miles(t.panelWouldShowMiles) }}</td>
                <!-- ⚠️ THE LOW END, never `typical`. Planning against the middle
                     of the interval is the ~2x-optimistic bug this check exists
                     to measure; overestimating strands a truck, underestimating
                     costs one fuel stop. -->
                <td class="num mono">
                  {{ miles(t.measuredLowMiles) }}
                  <div class="dim tiny">low end &mdash; the planning figure</div>
                </td>
                <td>
                  <span :class="['status-pill', verdictClass(t.verdict)]">{{ verdictLabel(t) }}</span>
                  <div v-if="t.legs" class="dim tiny">{{ t.legs }} fill-up<template v-if="t.legs !== 1">s</template> measured</div>
                </td>
              </tr>
            </tbody>
          </table>
        </template>
      </section>

      <!-- ================= Needs a decision ================= -->
      <section v-if="!focus" class="section decisions">
        <div class="section-title">
          <div class="section-icon icon-violet">&#10067;</div>
          Needs a decision
          <span class="section-sub">Open questions only the owner can settle</span>
        </div>

        <div v-for="d in decisions" :key="d.id" class="decision">
          <div class="decision-q">{{ d.question }}</div>
          <dl class="decision-body">
            <dt>What we know</dt>
            <dd>
              <ul class="evidence">
                <li v-for="(e, i) in d.evidence" :key="i" :class="{ 'evidence-warn': e.warn }">
                  <span class="ev-label">{{ e.label }}</span>
                  <span class="ev-value mono">{{ e.value }}</span>
                  <span v-if="e.note" class="ev-note">{{ e.note }}</span>
                </li>
              </ul>
            </dd>
            <dt>What it costs</dt>
            <dd>{{ d.impact }}</dd>
            <dt>What changes once you answer</dt>
            <dd>{{ d.unblocks }}</dd>
          </dl>
          <button
            v-if="d.jumpTo"
            type="button"
            class="action-btn act-open"
            @click="toggleFocus(d.jumpTo)"
          >Show the receipts</button>
        </div>
      </section>
    </template>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, h } from 'vue'
import { useRouter } from 'vue-router'
import { fmtYmd, fmtTimestamp } from '../utils/datetime'
import { useApi } from '../composables/useApi'
import { useToast } from '../composables/useToast'
import {
  ISSUE_QUEUES, RATECON_COST_NOTE,
  emptyQueueState, queueAnswered, queueErrorText,
  queueEstablished, queueInconclusiveText,
  duplicateGroups, duplicateSummary, duplicateRowCounts,
  rateconReport, onboardingFailures, regenerateBlockedReason,
  linxupReport, verifyTrucks, countVerifyChecks,
  tankDecisionCandidate, tankDecisionFallback,
} from '../lib/dataIssues'

const api = useApi()
const router = useRouter()
const { show: toast } = useToast()

// Registry as a lookup, so the template names a queue once instead of repeating
// its copy — same reason ExpensesTab drives its bar off a list.
const Q = Object.fromEntries(ISSUE_QUEUES.map((q) => [q.key, q]))

const loading = ref(true)
const focus = ref('')
const busy = ref('')

// Per-queue state. Five endpoints, five independent failure modes: one 403 must
// never silence the other four, and must never be rendered as "all clear".
const st = ref(Object.fromEntries(ISSUE_QUEUES.map((q) => [q.key, emptyQueueState(q)])))

const AUTO_KEYS = ISSUE_QUEUES.filter((q) => !q.manual).map((q) => q.key)

async function fetchQueue(key, url, opts) {
  st.value = { ...st.value, [key]: { status: 'loading', error: '', httpStatus: 0, data: null } }
  try {
    const data = await api.get(url, opts)
    st.value = { ...st.value, [key]: { status: 'ok', error: '', httpStatus: 200, data } }
  } catch (err) {
    st.value = {
      ...st.value,
      [key]: { status: 'error', error: err.message || '', httpStatus: err.status || 0, data: null },
    }
  }
}

const loadDuplicates = () => fetchQueue('duplicates', '/api/expenses/fuel-analytics')
const loadOnboarding = () => fetchQueue('onboarding', '/api/admin/onboarding-doc-failures')
const loadLinxup = () => fetchQueue('linxup', '/api/eld/linxup/health')
const loadVerify = () => fetchQueue('fuelverify', '/api/fuel/verify')

// `dryRun=true` is an inert no-op server-side (the GET never alerts since the
// GET/POST split) and is sent only so the request matches the existing runbook.
// The 60s timeout is not padding: this call blocks on an IMAP round trip to the
// production mailbox and the client default is 20s.
const loadRatecon = () =>
  fetchQueue('ratecon', '/api/admin/ratecon-reconcile?dryRun=true', { timeout: 60000 })

async function loadAll() {
  loading.value = true
  await Promise.all([loadDuplicates(), loadOnboarding(), loadLinxup(), loadVerify()])
  loading.value = false
}

const answered = (k) => queueAnswered(st.value[k])
const loadFailed = computed(() => AUTO_KEYS.every((k) => st.value[k].status === 'error'))
const firstError = computed(() => {
  for (const k of AUTO_KEYS) if (st.value[k].status === 'error') return st.value[k].error
  return ''
})

// --- Derived views over each payload ---------------------------------------
const dupGroups = computed(() => duplicateGroups(st.value.duplicates.data))
const dupSummary = computed(() => duplicateSummary(st.value.duplicates.data))
const dupCounts = computed(() => duplicateRowCounts(dupGroups.value))

const ratecon = computed(() => rateconReport(st.value.ratecon.data))
const onboardingRows = computed(() => onboardingFailures(st.value.onboarding.data))
const linxup = computed(() => linxupReport(st.value.linxup.data))
const verifyPayload = computed(() => st.value.fuelverify.data)
const verifyRows = computed(() => verifyTrucks(verifyPayload.value))

// --- The queue bar ----------------------------------------------------------
// A toggle appears only for a queue that ANSWERED and holds something. A queue
// that failed gets a separate, quieter line — putting it in the bar with a
// count would state a number nobody measured.
const queueCounts = computed(() => ({
  duplicates: dupCounts.value,
  onboarding: { actionable: onboardingRows.value.length, closed: 0, total: onboardingRows.value.length },
  linxup: linxup.value?.meaningful
    ? { actionable: linxup.value.unlinked, closed: 0, total: linxup.value.unlinked }
    : { actionable: 0, closed: 0, total: 0 },
  fuelverify: {
    actionable: countVerifyChecks(verifyRows.value),
    closed: 0,
    total: countVerifyChecks(verifyRows.value),
  },
  ratecon: ratecon.value
    ? { actionable: ratecon.value.missing.length, closed: 0, total: ratecon.value.missing.length }
    : { actionable: 0, closed: 0, total: 0 },
}))

const queueToggles = computed(() =>
  ISSUE_QUEUES
    .filter((q) => answered(q.key) && (queueCounts.value[q.key]?.total || 0) > 0)
    .map((q) => {
      const c = queueCounts.value[q.key]
      return {
        key: q.key,
        label: q.label,
        // `actionable` leads because the count exists to answer "how much work
        // is there"; a closed tally rides alongside instead of being folded in.
        countText: !c.closed
          ? `(${c.actionable})`
          : (!c.actionable ? `(${c.closed} closed)` : `(${c.actionable}) · ${c.closed} closed`),
      }
    }),
)

// The context two of the checks need before their zero means anything. See
// queueEstablished(): a 200 carrying a well-formed 0 is not a clean result when
// the detector behind it was never switched on.
const establishCtx = computed(() => ({
  sweepHasRun: Boolean(verifyPayload.value?.sweepHasRun),
  linxupMeaningful: Boolean(linxup.value?.meaningful),
  linxupHasToken: Boolean(linxup.value?.hasToken),
}))
const established = (k) => answered(k) && queueEstablished(k, establishCtx.value)

// Reassurance limited to what actually got measured — never a page-wide "all
// clear", which would speak for a check that failed, never ran, or ran with its
// detector switched off.
const clearText = computed(() => {
  if (queueToggles.value.length) return ''
  const parts = ISSUE_QUEUES
    .filter((q) => established(q.key) && (queueCounts.value[q.key]?.total || 0) === 0)
    .map((q) => q.clear)
  if (!parts.length) return ''
  const joined = parts.length === 1
    ? parts[0]
    : parts.slice(0, -1).join(', ') + ', and ' + parts[parts.length - 1]
  return 'All clear — ' + joined + '.'
})

// The counterweight to the sentence above: everything we could NOT establish,
// whether because the call failed or because the detector behind it is off.
const unestablished = computed(() =>
  ISSUE_QUEUES.filter((q) => !established(q.key)))
const unavailableText = computed(() => {
  const n = unestablished.value.length
  return n ? `${n} check${n === 1 ? '' : 's'} couldn't tell us` : ''
})
const unavailableTitle = computed(() =>
  unestablished.value
    .map((q) => {
      const why = queueInconclusiveText(q.key, establishCtx.value)
      return why ? `${q.label} — ${why}` : `${q.label} — couldn't load`
    })
    .join('\n'))

function toggleFocus(k) { focus.value = focus.value === k ? '' : k }
function visible(k) { return !focus.value || focus.value === k }

function toggleStyle(which) {
  const on = focus.value === which
  return {
    display: 'inline-flex', alignItems: 'center', whiteSpace: 'nowrap',
    padding: '0.4rem 0.75rem', fontSize: '0.75rem', fontWeight: '600',
    borderRadius: '6px', cursor: 'pointer', fontFamily: 'inherit',
    border: '1px solid ' + (on ? '#f59e0b' : '#d1d5db'),
    background: on ? '#fef3c7' : '#ffffff',
    color: on ? '#92400e' : '#374151',
    transition: 'all 0.15s',
  }
}

// --- Formatting -------------------------------------------------------------
const fmtDate = (d) => fmtYmd(d)
const fmtWhen = (t) => (t ? fmtTimestamp(t) : '')

// ⚠️ EVERY MONEY FIGURE ON THIS PAGE IS CENTS-EXACT, INCLUDING THE ROLLUP, and
// that is a deliberate departure from utils/format's formatCurrency().
//
// formatCurrency() rounds to whole dollars, which is right for a settlement
// total and wrong here twice over. First, the amount IS the evidence: two rows
// matching at $431.87 is what makes them a duplicate, and $432 twice is not the
// same claim. Second, the rollup has to reconcile to the rows rendered directly
// beneath it — the live figures are $400.00 + $400.00 + $300.00 + $15.25 +
// $0.10, and a rounded header reading "$1,115" over rows summing to $1,115.35
// is an arithmetic contradiction on one screen.
//
// Same helper and same reasoning as fmtMoney() in ExpensesTab's review queues,
// which is the established formatter for exactly this kind of queue.
function money(v) {
  return v === null || v === undefined
    ? '—'
    : '$' + Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}
const miles = (v) => (v === null || v === undefined ? '—' : Math.round(v).toLocaleString('en-US') + ' mi')

const VERDICT_CLASS = { over: 'st-owed', under: 'st-owed', ok: 'st-paid', unmeasured: 'st-processing' }
const verdictClass = (v) => VERDICT_CLASS[v] || 'st-processing'
function verdictLabel(t) {
  if (t.verdict === 'unmeasured') return 'not measured'
  if (t.verdict === 'ok') return 'agrees'
  const f = t.overstatementFactor
  return t.verdict === 'over'
    ? `reads ${f.toFixed(2)}× high`
    : `reads ${(1 / f).toFixed(2)}× low`
}

// --- Actions ----------------------------------------------------------------

// Duplicate receipts have NO write path — no void, no merge, no delete — so the
// only action a row earns is going to look at it. Precedent: openReceiptRow()
// in ExpensesTab, which likewise navigates rather than mutating.
//
// `?expense=<id>` is consumed by ExpensesView/ExpensesTab (PR #265): it pages to
// the row, opens it through that same openReceiptRow(), and clears the param.
// So this hands off a row id and nothing more — deciding what to do when the id
// cannot be shown belongs there, on the surface that knows the filter state, and
// must not be second-guessed here. The expense id stays rendered in the table
// regardless, so a row remains identifiable without relying on the navigation.
function openExpense(row) {
  if (row?.id == null) return
  router.push({ path: '/expenses', query: { expense: String(row.id) } })
}

const regenBlocked = (f) => regenerateBlockedReason(f)

async function regenerate(f) {
  const blocked = regenBlocked(f)
  if (blocked) { toast(blocked, 'warning'); return }
  if (busy.value) return
  busy.value = f.alertKey
  try {
    // ⚠️ NO `force`, ever, from this button. Plain regenerate is the recovery
    // path: it re-renders only when the artifact is missing or the row was
    // never signed. `force: true` on a signed document WITH a valid artifact
    // supersedes an executed contract — the server demands a written reason for
    // exactly that case, and this queue is not where that decision belongs.
    const r = await api.post(
      `/api/admin/investor-onboarding/${f.ownerId}/documents/${encodeURIComponent(f.docKey)}/regenerate`,
      {},
    )
    toast(r?.regenerated
      ? `${f.docName || f.docKey} regenerated`
      : 'Already on file — nothing needed regenerating')
    await loadOnboarding()
  } catch (err) {
    toast(err.message || 'Could not regenerate that document', 'error')
  } finally {
    busy.value = ''
  }
}

// --- Needs a decision -------------------------------------------------------
// Each card: the question, the evidence behind it, what it costs to leave open,
// and what becomes possible once it is answered. The tank card is built from
// live data so it cannot go stale; the other three are settled facts.
const decisions = computed(() => {
  const out = []

  // 1. Tank size. Sourced from GET /api/fuel/verify's own tank evidence.
  //
  // ⚠️ THE CARD RENDERS EVEN WITH NO EVIDENCE. With the fuel-event sweep off,
  // tankEvidence is null on every truck — measured on a production snapshot,
  // where #33 was still configured at 300 gal driving a 449-mile panel figure.
  // Dropping the question there would hide it exactly when nothing is measuring
  // it, so the fallback names the truck and says what is missing instead.
  const cand = tankDecisionCandidate(verifyRows.value)
  const fallbackTruck = cand ? null : tankDecisionFallback(verifyRows.value)
  if (cand || fallbackTruck) {
    const t = cand ? cand.truck : fallbackTruck
    const ev = t.tank
    const rows = [
      {
        label: 'Configured today',
        value: t.tankGallons !== null ? `${t.tankGallons} gal` : 'not set',
        note: t.tankSource === 'default' ? 'nobody set this — it is the 200 gal fleet default' : '',
        warn: t.tankSource === 'default',
      },
    ]
    // What the driver is shown right now, which is the thing the tank scales.
    if (t.panelWouldShowMiles !== null && t.measuredLowMiles !== null) {
      rows.push({
        label: 'Range shown vs planning',
        value: `${miles(t.panelWouldShowMiles)} vs ${miles(t.measuredLowMiles)}`,
        note: 'the low end is what a driver should plan against',
      })
    }
    if (!ev) {
      rows.push({
        label: 'Corroborating evidence',
        value: 'none yet',
        note: 'the fuel-event sweep has not run, so there are no fills to infer capacity from',
        warn: true,
      })
    }
    // ⚠️⚠️ THE SENSED FIGURE IS LISTED AS EVIDENCE AND EXPLICITLY REFUSED AS AN
    // ANSWER. The calibration is bimodal because the sender reads ONE saddle
    // tank, so its lower mode measures sensed volume, not capacity. Presenting
    // it as "the true tank" would halve the displayed range — the direction
    // that strands a truck rather than costing it a fuel stop.
    if (ev?.bimodal && ev.sensedLowerMode) {
      rows.push({
        label: 'Sensed by the gauge',
        value: `${Math.round(ev.sensedLowerMode)} gal`,
        note: 'ONE saddle tank, not the capacity — do not set this as the tank size',
        warn: true,
      })
    }
    if (ev?.burnImplied) {
      rows.push({ label: 'Implied by fuel burn', value: `${ev.burnImplied} gal`, note: 'from miles-per-point ÷ MPG' })
    }
    if (ev?.floor) {
      rows.push({
        label: 'Largest single fill',
        value: `${ev.floor} gal`,
        note: 'a hard floor — the tank cannot be smaller than this',
      })
    }
    out.push({
      id: 'tank',
      question: `What is ${t.unitNumber}'s real tank size?`,
      evidence: rows,
      impact:
        'Tank size scales every range figure the driver and dispatch see. Set it too high and a truck runs '
        + 'dry short of the stop; set it too low and it makes an unnecessary fuel stop. '
        + (cand
          ? `The two independent estimates disagree with the configured value by about ${cand.gapPct}%.`
          : 'Nothing is currently corroborating the configured figure.'),
      unblocks: cand
        ? 'A confirmed capacity makes the range panel trustworthy without the derate, and lets trip planning '
          + 'answer "will this load fit in the tank" instead of hedging.'
        : 'Confirming the capacity — and turning the fuel-event sweep on so the truck can check it against its '
          + 'own fills — is what makes the range figure something a driver can plan against.',
    })
  }

  // 2. Geofence radius.
  out.push({
    id: 'geofence',
    question: 'Is a 2-mile detention geofence the right size?',
    evidence: [
      { label: 'Radius today', value: '2 mi', note: 'GEOFENCE_RADIUS_M, raised from 1,000 m on 2026-08-06' },
      { label: 'Audit history', value: 'mixed', note: 'rows before that date legitimately read "radius 1000 m"', warn: true },
    ],
    impact:
      'The radius decides when "At Shipper" and "In Transit" fire, so it sets the shipper detention window '
      + 'the carrier bills from. Too wide and the truck is marked arrived while still miles out; too narrow '
      + 'and a short load never leaves the pickup circle at all.',
    unblocks:
      'A confirmed radius lets detention time be quoted to brokers as measured rather than indicative.',
  })

  // 3. Receipt #172.
  out.push({
    id: 'receipt172',
    question: 'Should receipt #172 be re-dated from 2017 to 2022?',
    evidence: [
      { label: 'Stored date', value: '2017-07-15' },
      { label: 'On the receipt', value: '2022', note: 'the paper itself reads 2022' },
      { label: 'Telemetry', value: 'none that far back', note: 'so it can never be paired with a refuel', warn: true },
    ],
    impact:
      'It is the one recovered receipt that cannot be matched to a fuel-up, so its gallons never reach the '
      + "truck's measured MPG. Left alone it is a permanent hole in the fuel history.",
    unblocks:
      'Correcting the year lets the next sweep pair it with a real refuel episode and fold its gallons into '
      + 'the MPG the driver is shown.',
  })

  // 4. Which duplicates to void — links back to the section above.
  const dupSum = dupSummary.value
  if (answered('duplicates') && dupSum && dupSum.groupCount > 0) {
    out.push({
      id: 'duplicates',
      question: 'Which of the duplicate receipts should be voided?',
      evidence: [
        { label: 'Booked twice', value: money(dupSum.excessAmount), note: 'excess across every group' },
        {
          label: 'Receipts',
          value: `${dupCounts.value.actionable} open · ${dupCounts.value.closed} closed`,
          note: dupCounts.value.closed
            ? 'the closed ones sit in finalized months and cannot be edited'
            : '',
          warn: dupCounts.value.closed > 0,
        },
        {
          label: 'Strongest evidence',
          value: `${dupSum.byConfidence.high} high-confidence group${dupSum.byConfidence.high === 1 ? '' : 's'}`,
        },
      ],
      impact:
        'Every duplicate inflates fuel spend and cost-per-mile, and flows into the investor payout for that '
        + 'month. The ones in closed months cannot be corrected in place at all — they need a settlement '
        + 'adjustment instead.',
      unblocks:
        'A decision on each group lets the open ones be corrected in Expenses and the closed ones be booked '
        + 'as prior-period adjustments, so fuel cost-per-mile stops reading high.',
      jumpTo: 'duplicates',
    })
  }

  return out
})

// The status box every section shows above its data. Kept local because its
// whole job is to enforce one rule — "couldn't ask", "asked but nothing was
// running", and "asked, nothing to report" are THREE different answers — and
// that rule is this page's reason to exist.
//
// A section whose queue answered empty must say so here rather than rely on the
// page-wide sentence in the bar: that sentence only appears when NO queue has
// rows, so with one noisy queue every clean section would render as a bare
// heading and read as broken.
const QueueStatus = (props, { emit }) => {
  const s = props.state
  if (!s) return null
  if (s.status === 'idle') {
    return props.idleText ? h('div', { class: 'q-idle' }, props.idleText) : null
  }
  if (s.status === 'loading') return h('div', { class: 'q-idle' }, 'Checking…')
  if (s.status === 'error') {
    return h('div', { class: 'q-error', role: 'status' }, [
      h('span', queueErrorText(s)),
      h('button', {
        type: 'button', class: 'action-btn act-retry',
        onClick: () => emit('retry'),
      }, 'Retry'),
    ])
  }
  // Answered. Only a queue whose detector actually ran may claim to be clear —
  // see queueEstablished(). Sections that render their own richer explanation
  // pass no `inconclusive` text and stay silent here.
  if (props.established === false) {
    return props.inconclusive
      ? h('div', { class: 'q-inconclusive' }, `Nothing established — ${props.inconclusive}.`)
      : null
  }
  if (props.empty) {
    return h('div', { class: 'q-clear' }, `All clear — ${props.clear}.`)
  }
  return null
}
QueueStatus.props = ['state', 'clear', 'idleText', 'empty', 'established', 'inconclusive']
QueueStatus.emits = ['retry']

onMounted(loadAll)
</script>

<style scoped>
/* .admin-page (shared.css) supplies the flex-column page frame. Only
   page-specific spacing lives here — same split as PayoutsView. */
.issues-page { gap: 1rem; padding-bottom: 2rem; }
.page-header h2 { font-size: 1.4rem; margin: 0; }
.page-sub {
  font-size: 0.82rem;
  color: var(--text-dim);
  margin-top: 0.2rem;
  max-width: 760px;
  line-height: 1.45;
}

.loading-state { display: flex; flex-direction: column; gap: 0.75rem; }
.skeleton-card {
  height: 100px;
  background: var(--bg);
  border-radius: 10px;
  animation: pulse 1.4s ease-in-out infinite;
}
@keyframes pulse { 0%, 100% { opacity: 0.4; } 50% { opacity: 0.7; } }

.error-state {
  background: var(--danger-dim, #fef2f2);
  border: 1px solid var(--danger-dim, #fecaca);
  border-radius: 10px;
  padding: 1rem 1.25rem;
  color: var(--danger, #b91c1c);
}
.error-title { font-weight: 700; font-size: 0.95rem; }
.error-msg { font-size: 0.8rem; margin: 0.35rem 0 0.75rem; }

/* Queue bar — same amber vocabulary as the Fuel Logs review bar and the load
   board's "Needs Review", so a queue looks the same everywhere. Nothing here is
   red: these are things to work through, not failures. */
.issue-bar {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
}
.issue-clear { font-size: 0.75rem; color: var(--text-dim); }
.issue-unavailable {
  font-size: 0.75rem;
  color: #92400e;
  background: #fffbeb;
  border-radius: 0.3rem;
  padding: 0.15rem 0.45rem;
  cursor: help;
}

.section {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 1.25rem;
}
.section-title {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  font-weight: 700;
  font-size: 0.95rem;
  margin-bottom: 1rem;
}
.section-icon {
  width: 28px; height: 28px; border-radius: 8px;
  display: flex; align-items: center; justify-content: center;
  font-size: 0.85rem; font-weight: 700;
  flex: none;
}
.icon-amber { background: var(--amber-dim, #fef3c7); color: var(--amber, #b45309); }
.icon-blue { background: var(--blue-dim, #dbeafe); color: var(--blue, #0369a1); }
.icon-violet { background: #ede9fe; color: #5b21b6; }
.section-sub {
  margin-left: auto;
  font-size: 0.72rem;
  font-weight: 500;
  color: var(--text-dim);
  text-align: right;
}

/* Three-state box: "checking", "couldn't load" and "all clear" are distinct and
   must never be mistaken for one another. */
.q-idle { font-size: 0.82rem; color: var(--text-dim); padding: 0.5rem 0; }
/* Earned reassurance — green, and only ever rendered for a check that actually
   ran. Quieter than the amber queues: nothing to do here. */
.q-clear {
  font-size: 0.82rem;
  color: #166534;
  background: #f0fdf4;
  border: 1px solid #bbf7d0;
  border-radius: 8px;
  padding: 0.6rem 0.75rem;
}
/* Answered, but its detector was switched off — neither work nor reassurance. */
.q-inconclusive {
  font-size: 0.82rem;
  color: var(--text-dim);
  background: var(--bg);
  border: 1px dashed var(--border);
  border-radius: 8px;
  padding: 0.6rem 0.75rem;
}
.q-error {
  display: flex; align-items: center; gap: 0.6rem; flex-wrap: wrap;
  font-size: 0.82rem;
  color: #92400e;
  background: #fffbeb;
  border: 1px solid #fde68a;
  border-radius: 8px;
  padding: 0.6rem 0.75rem;
}

/* Rollups */
.rollup {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 0.75rem;
  margin-bottom: 1rem;
}
.rollup-card {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 0.85rem 1rem;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}
.rollup-label {
  font-size: 0.66rem; font-weight: 700; text-transform: uppercase;
  letter-spacing: 0.06em; color: var(--text-dim);
}
.rollup-value { font-size: 1.2rem; font-weight: 800; }
.rollup-value.small { font-size: 0.9rem; font-weight: 700; }
.rollup-note { font-size: 0.7rem; color: var(--text-dim); line-height: 1.35; }
.conf-row { display: flex; gap: 0.35rem; flex-wrap: wrap; }

.split-fix { color: #b45309; }
.split-sep { color: var(--text-dim); margin: 0 0.15rem; }
.split-closed { color: var(--text-dim); font-weight: 600; font-size: 0.95rem; }

.read-only-note {
  font-size: 0.78rem;
  color: var(--text-dim);
  line-height: 1.5;
  background: var(--bg);
  border-left: 3px solid var(--border);
  border-radius: 0 6px 6px 0;
  padding: 0.55rem 0.75rem;
  margin: 0 0 1rem;
}

/* Duplicate groups */
.dup-group {
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 0.75rem 0.9rem;
  margin-bottom: 0.75rem;
}
.dup-closed { background: var(--bg); }
.dup-head {
  display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap;
  font-size: 0.85rem;
}
.dup-amount { font-weight: 800; }
.dup-times { font-weight: 700; color: #b91c1c; }
.dup-where { color: var(--text-dim); font-size: 0.8rem; }
.dup-excess { margin-left: auto; font-weight: 700; color: #b91c1c; }
.dup-reasons {
  font-size: 0.72rem; color: var(--text-dim);
  margin: 0.3rem 0 0.5rem;
}
.dup-table { margin-top: 0.25rem; }

.conf {
  font-size: 0.62rem; font-weight: 700; text-transform: uppercase;
  letter-spacing: 0.04em; border-radius: 999px; padding: 0.1rem 0.4rem;
}
.conf-high { background: #fee2e2; color: #991b1b; }
.conf-medium { background: #fef3c7; color: #92400e; }
.conf-low { background: #f1f5f9; color: #475569; }

.closed-chip {
  display: inline-block; margin-left: 0.35rem;
  font-size: 0.62rem; font-weight: 700; text-transform: uppercase;
  letter-spacing: 0.03em; color: #64748b; background: #f1f5f9;
  border-radius: 0.25rem; padding: 0.1rem 0.3rem; cursor: help;
}

/* Tables — same vocabulary as PayoutsView so admin pages read alike. */
.data-table {
  width: 100%;
  border-collapse: separate;
  border-spacing: 0;
  font-size: 0.82rem;
}
.data-table th {
  text-align: left;
  padding: 0.5rem;
  font-weight: 600;
  color: var(--text-dim);
  border-bottom: 2px solid var(--border);
  font-size: 0.68rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.data-table th.num, .data-table td.num { text-align: right; }
.data-table th.action-head { text-align: right; }
.data-table td {
  padding: 0.55rem 0.5rem;
  border-bottom: 1px solid var(--bg);
  vertical-align: middle;
}
.data-table.compact td, .data-table.compact th { padding: 0.35rem 0.5rem; }
.data-table td.mono, .mono { font-family: 'JetBrains Mono', monospace; }
.data-table td.dim, .dim { color: var(--text-dim); }
.strong { font-weight: 700; }
.tiny { font-size: 0.7rem; }
.subject-cell { max-width: 26rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* A closed row is reference material, not work — greyed so it reads that way
   without being hidden. */
.row-locked td { color: var(--text-dim); }

.action-cell { text-align: right; white-space: nowrap; }
.action-btn {
  font: inherit; font-size: 0.72rem; font-weight: 600;
  padding: 0.3rem 0.65rem; border-radius: 6px;
  border: 1px solid transparent; cursor: pointer;
  transition: all 0.15s;
}
.action-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.act-open { background: #e0e7ff; color: #3730a3; }
.act-open:hover:not(:disabled) { background: #c7d2fe; }
.act-regen { background: #ede9fe; color: #5b21b6; }
.act-regen:hover:not(:disabled) { background: #ddd6fe; }
.act-retry { background: #fef3c7; color: #92400e; }
.act-retry:hover:not(:disabled) { background: #fde68a; }

.status-pill {
  display: inline-block;
  font-size: 0.66rem; font-weight: 700; text-transform: uppercase;
  letter-spacing: 0.05em; padding: 0.2rem 0.55rem;
  border-radius: 10px; white-space: nowrap;
}
.status-pill.st-owed { background: #fef3c7; color: #92400e; }
.status-pill.st-processing { background: #f1f5f9; color: #475569; }
.status-pill.st-paid { background: #dcfce7; color: #166534; }

/* Manual-run row for the one check that costs a mailbox sweep. */
.manual-run {
  display: flex; align-items: center; gap: 1rem; flex-wrap: wrap;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 0.7rem 0.85rem;
  margin-bottom: 0.75rem;
}
.manual-copy { font-size: 0.78rem; color: var(--text-dim); flex: 1; min-width: 16rem; line-height: 1.45; }
.scan-meta { font-size: 0.78rem; color: var(--text-dim); margin-bottom: 0.75rem; line-height: 1.5; }
.warn-inline { color: #92400e; cursor: help; }
.err-inline {
  font-size: 0.78rem; color: #b91c1c;
  background: #fef2f2; border-radius: 6px;
  padding: 0.45rem 0.6rem; margin-bottom: 0.75rem;
}

/* Needs a decision */
.decision {
  border: 1px solid var(--border);
  border-left: 3px solid #8b5cf6;
  border-radius: 0 10px 10px 0;
  padding: 0.9rem 1rem;
  margin-bottom: 0.75rem;
}
.decision-q { font-weight: 700; font-size: 0.9rem; margin-bottom: 0.6rem; }
.decision-body { margin: 0; font-size: 0.8rem; line-height: 1.5; }
.decision-body dt {
  font-size: 0.65rem; font-weight: 700; text-transform: uppercase;
  letter-spacing: 0.06em; color: var(--text-dim); margin-top: 0.5rem;
}
.decision-body dd { margin: 0.2rem 0 0; color: var(--text); }
.evidence { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.2rem; }
.evidence li { display: flex; gap: 0.5rem; flex-wrap: wrap; align-items: baseline; }
.ev-label { color: var(--text-dim); min-width: 10rem; }
.ev-value { font-weight: 700; }
.ev-note { color: var(--text-dim); font-size: 0.75rem; }
/* The one figure a reader must not act on gets the amber treatment. */
.evidence-warn .ev-note { color: #92400e; font-weight: 600; }
.decision .action-btn { margin-top: 0.7rem; }

@media (max-width: 768px) {
  .rollup { grid-template-columns: 1fr; }
  .data-table { font-size: 0.78rem; }
  .data-table th, .data-table td { padding: 0.4rem 0.35rem; }
  .section-sub { display: none; }
  .dup-excess { margin-left: 0; }
  .ev-label { min-width: 0; }
  .issue-bar button { justify-content: center; flex: 1 1 100%; }
}
</style>
