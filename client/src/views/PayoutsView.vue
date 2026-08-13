<template>
  <div class="admin-page payouts-page">
    <div class="page-header">
      <h2>Payouts</h2>
      <p class="page-sub">
        Monthly investor settlements across the whole fleet &mdash; what's owed, what's processing,
        and how much you pay out each month. Advance a payout from owed &rarr; processing &rarr; paid,
        or <strong>Reopen</strong> one that was advanced by mistake.
      </p>
    </div>

    <div v-if="loading" class="loading-state">
      <div class="skeleton skeleton-card" v-for="i in 4" :key="i"></div>
    </div>

    <template v-else-if="loadFailed">
      <div v-if="notFound" class="empty">
        Payout settlements aren't available yet.
      </div>
      <div v-else class="error-state">
        <div class="error-title">Could not load payouts</div>
        <div class="error-msg">{{ errorMsg || 'Something went wrong — try again.' }}</div>
        <button class="btn btn-primary" @click="loadPayouts">Retry</button>
      </div>
    </template>

    <template v-else>
      <!-- 1. Grand totals -->
      <section class="section">
        <div class="section-title">
          <div class="section-icon" style="background: var(--accent-dim); color: var(--accent);">&#128176;</div>
          Settlement Totals
          <span class="section-sub">Across all investors, all periods</span>
        </div>
        <div class="totals-grid">
          <div class="total-card amber">
            <span class="total-label">Total Owed</span>
            <span class="total-value mono">{{ fmt(grandTotals.totalOwed) }}</span>
          </div>
          <div class="total-card blue">
            <span class="total-label">Total Processing</span>
            <span class="total-value mono">{{ fmt(grandTotals.totalProcessing) }}</span>
          </div>
          <div class="total-card green">
            <span class="total-label">Total Paid</span>
            <span class="total-value mono">{{ fmt(grandTotals.totalPaid) }}</span>
          </div>
        </div>
      </section>

      <!-- 2. Monthly payout totals — "how much I pay out each month" -->
      <section class="section">
        <div class="section-title">
          <div class="section-icon" style="background: var(--amber-dim); color: var(--amber);">&#128197;</div>
          Monthly Payout Totals
          <span class="section-sub">Settled across all investors, newest first</span>
        </div>
        <div v-if="!monthlyTotals.length" class="empty-msg">No monthly payout history yet.</div>
        <table v-else class="data-table monthly-table">
          <thead>
            <tr>
              <th>Period</th>
              <th class="num">Owed</th>
              <th class="num">Processing</th>
              <th class="num">Paid</th>
              <th class="num">Total</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="m in monthlyTotals" :key="m.period">
              <td class="mono">{{ m.periodLabel }}</td>
              <td class="num amber">{{ fmt(m.owed) }}</td>
              <td class="num blue">{{ fmt(m.processing) }}</td>
              <td class="num green">{{ fmt(m.paid) }}</td>
              <td class="num strong">{{ fmt(m.total) }}</td>
            </tr>
          </tbody>
        </table>
      </section>

      <!-- 2b. Month-close calendar.
           The client asked "is there anything specific I have to do to close out
           the previous one within the 7 day window?" — the answer is NO, and no
           screen said so, which is why he had to ask. The console only ever
           rendered payout rows, so the close lifecycle had to be inferred from
           them. This panel states it. -->
      <section class="section calendar-section">
        <div class="section-title">
          <div class="section-icon" style="background: var(--blue-dim); color: var(--blue);">&#128197;</div>
          Month-Close Calendar
          <span class="section-sub">Which months are open, which are closed, and who closed them</span>
        </div>

        <!-- The headline answer, stated before any table. -->
        <div :class="['close-answer', closeMode]">
          <template v-if="closeMode === 'auto'">
            <div class="ca-title">Nothing to do &mdash; months close themselves.</div>
            <p class="ca-body">
              <template v-if="graceDays > 0">
                A month stays open for <strong>{{ graceDays }} more {{ graceDays === 1 ? 'day' : 'days' }}</strong>
                after it ends so late receipts still count. It then closes on its own, automatically, at the
                start of the following day.
              </template>
              <template v-else>
                A month closes on its own, automatically, as soon as it ends &mdash; there is no extra window
                for late receipts.
              </template>
              You do not have to click anything.
              <template v-if="autoClosedCount">
                {{ autoClosedCount }} of the {{ closedCount }} closed
                {{ closedCount === 1 ? 'month' : 'months' }} below
                {{ autoClosedCount === 1 ? 'was' : 'were' }} closed this way.
              </template>
            </p>
            <p class="ca-body dim">
              <strong>Close now</strong> is only for when every receipt for a month is already in and you
              would rather not wait out the window. <strong>Reopen Month</strong> puts a closed month back
              in the "late receipts still count" state for every investor.
            </p>
          </template>

          <template v-else-if="closeMode === 'manual'">
            <div class="ca-title">Automatic month-close is switched off on this server.</div>
            <p class="ca-body">
              Months will <strong>not</strong> close on their own here, so no month has a scheduled close
              date and every figure keeps moving as receipts arrive. Payouts also can't be settled against
              a frozen number until a month is closed. Ask an administrator to enable period close
              (<span class="mono-inline">PERIOD_FINALIZE_ENABLED</span>) to restore the automatic
              {{ graceDays > 0 ? graceDays + '-day' : 'month-end' }} close.
            </p>
          </template>

          <template v-else>
            <div class="ca-title">Close schedule unavailable.</div>
            <p class="ca-body">
              The calendar couldn't be read, so this page can't confirm whether months are closing
              automatically. Everything below is reconstructed from the payout data already loaded.
            </p>
          </template>
        </div>

        <!-- Placeholder only while there is genuinely nothing to show. On a
             refresh the previous rows stay put rather than flashing to "Loading". -->
        <div v-if="periodsLoading && !calendarRows.length" class="empty-msg">Loading close calendar…</div>
        <template v-else>
          <!-- ⚠️ INDEPENDENT FAILURE. GET /api/periods deliberately 500s when
               period_locks is malformed rather than fabricating a calendar, while
               /api/payouts degrades with a flag instead. So a failure here must
               not blank the page: it degrades to a calendar rebuilt from the
               payout rows already in hand — exactly the data the per-investor
               period buttons used to run on — so Close now / Reopen Month keep
               working. What is genuinely lost is named, not glossed over. -->
          <div v-if="periodsFailed" class="calendar-warn">
            <strong>Couldn't load the close calendar.</strong>
            {{ periodsErrorMsg || 'Something went wrong.' }}
            <template v-if="calendarRows.length">
              Showing what the payout data knows instead &mdash; who closed each month, the length of the
              window, and any month with no payout row are all missing from this view.
            </template>
            <button type="button" class="calendar-retry" @click="loadPeriods">Retry</button>
          </div>

          <div v-if="!calendarRows.length && !periodsFailed" class="empty-msg">
            No settlement months yet.
          </div>

          <!-- Scroll wrapper, not a stacked card list: this table is read as a
               calendar (which month is where in the lifecycle), and that reading
               depends on the rows staying aligned in one column of dates. -->
          <div v-else-if="calendarRows.length" class="calendar-scroll">
            <table class="data-table calendar-table">
              <thead>
                <tr>
                  <th>Month</th>
                  <th>Status</th>
                  <th>Receipts accepted through</th>
                  <th>Closed</th>
                  <th class="action-head"></th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="r in calendarRows" :key="r.period">
                  <td class="mono">
                    {{ r.periodLabel }}
                    <span v-if="r.period && r.period === currentPeriod" class="cur-flag">current</span>
                  </td>
                  <td>
                    <span :class="['status-pill', phaseMeta(r).cls]" :title="phaseMeta(r).hint">{{ phaseMeta(r).label }}</span>
                    <!-- A month walked back open reads identically to one that was
                         never closed, so mark it. -->
                    <span v-if="r.reopenedAt" class="reopened-flag" :title="periodReopenTitle(r)">reopened</span>
                  </td>
                  <!-- ⚠️ graceEndsAt is the LAST day the books are open, INCLUSIVE —
                       "closes Aug 7" would be read as closing a day early and costs a
                       receipt. Both dates are spelled out. -->
                  <td class="dim">
                    <template v-if="r.phase === 'finalized'">&mdash;</template>
                    <template v-else-if="r.graceEndsAt">
                      <span class="grace-day">{{ fmtDate(r.graceEndsAt) }}</span>
                      <span v-if="closesOn(r.graceEndsAt)" class="grace-sub">
                        all day &middot; locks {{ closesOn(r.graceEndsAt) }}
                      </span>
                    </template>
                    <template v-else>&mdash;</template>
                  </td>
                  <td class="dim">
                    <template v-if="r.phase === 'finalized' && r.finalizedAt">
                      <span class="closed-on" :title="fmtTimestamp(r.finalizedAt)">{{ fmtDate(r.finalizedAt) }}</span>
                      <span v-if="finalizedByLabel(r)" class="closed-by">{{ finalizedByLabel(r) }}</span>
                    </template>
                    <template v-else-if="r.phase === 'finalized'">
                      <span class="closed-by">closed</span>
                    </template>
                    <template v-else>&mdash;</template>
                  </td>
                  <td class="action-cell">
                    <!-- Both verbs are FLEET-WIDE — one carrier, one month-end — so
                         this calendar is their single home. `finalizeTarget` /
                         `periodReopenTarget` only ever read period / periodLabel /
                         graceEndsAt, all of which a /api/periods row carries, so the
                         existing modals and save handlers take these rows unchanged.

                         Gating on `phase` alone is deliberate and sufficient:
                         periodPhase() returns 'pending' ONLY when period close is
                         enabled, so a pending row can never offer a click the server
                         would answer with 503 FEATURE_DISABLED. -->
                    <button
                      v-if="r.phase === 'pending'"
                      type="button"
                      class="action-btn act-finalize"
                      :disabled="periodSaving"
                      title="Close this month now — every receipt is in. Freezes every investor's figure and publishes their statements."
                      @click="openFinalize(r)"
                    >Close now</button>
                    <button
                      v-else-if="r.phase === 'finalized'"
                      type="button"
                      class="action-btn act-reopen-period"
                      :disabled="periodSaving"
                      title="Reopen this month for everyone so late receipts count again"
                      @click="openPeriodReopen(r)"
                    >Reopen Month</button>
                    <span v-else class="await-note">{{ noActionNote(r) }}</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <!-- Legacy receipts the period lock REFUSED to attribute. Had no home
               anywhere in the UI until now, so the condition could accumulate
               silently — which is the one thing a health counter must not do. -->
          <div v-if="backfillBlocked" class="calendar-warn backfill-warn">
            <div v-if="backfill.skippedLockedPeriod">
              <strong>{{ backfill.skippedLockedPeriod }} legacy
              {{ backfill.skippedLockedPeriod === 1 ? 'receipt is' : 'receipts are' }} unattributed.</strong>
              Their month was already closed, so the attribution pass refused to write into it rather than
              restating a settled figure. Until that is resolved they count against no investor.
              <template v-if="backfill.skippedPeriods && backfill.skippedPeriods.length">
                Affected:
                <span class="bf-periods">{{ backfill.skippedPeriods.join(', ') }}</span>.
              </template>
              <span class="bf-how">
                To take them in, reopen the listed {{ backfill.skippedPeriods && backfill.skippedPeriods.length === 1 ? 'month' : 'months' }} above
                &mdash; the attribution runs at server start, so it completes on the next restart.
              </span>
            </div>
            <div v-if="backfill.error" class="bf-error">
              Attribution pass reported an error: {{ backfill.error }}
            </div>
            <div v-if="backfill.ranAt" class="bf-meta">
              Last run {{ fmtTimestamp(backfill.ranAt) }} &middot; {{ backfill.applied || 0 }} receipt(s) attributed.
            </div>
          </div>
        </template>
      </section>

      <!-- 3. Per-investor settlement -->
      <div v-if="!investors.length" class="empty">No investors with payouts yet.</div>
      <section
        v-for="inv in investors"
        :key="inv.ownerId"
        class="section investor-section"
      >
        <div class="section-title">
          <div class="section-icon" style="background: var(--blue-dim); color: var(--blue);">&#128188;</div>
          {{ inv.name }}
          <span class="section-sub">
            Owed {{ fmt(inv.totalOwed) }} &middot; Processing {{ fmt(inv.totalProcessing) }} &middot; Paid {{ fmt(inv.totalPaid) }}
          </span>
        </div>

        <!-- Current month: accruing, not yet payable.

             ⚠️ THE SIGNED `amountInProgress` HERE IS DELIBERATE — DO NOT
             "align" it with the investor's own card. This is the Super Admin
             console: admins settle money and must see a month running at a
             deficit (a live investor sat at -$2,450). The investor-facing
             component renders `payableIfClosedNow` instead, which is clamped at
             $0 and never negative.

             The asymmetry is the design: ADMINS SEE THE TRUTH, INVESTORS SEE
             WHAT THEY WOULD BE PAID. It will look like an inconsistency to
             whoever reads these two files next, which is exactly why it is
             written down at both render sites. The server deliberately does not
             clamp either, because `amountInProgress` is an accrual and a term
             in the ledger identity test-suite.js 53 asserts. See the long note
             beside hasProjection in
             components/investor/PayoutsSection.vue. -->
        <div v-if="inv.currentMonth" class="current-card">
          <div class="current-main">
            <span class="current-label">{{ inv.currentMonth.periodLabel }}</span>
            <span class="current-amount mono">{{ fmt(inv.currentMonth.amountInProgress) }}</span>
          </div>
          <div class="current-meta">
            <span class="status-pill st-progress">in progress</span>
            <span class="current-note">
              Accruing this month &mdash; not yet payable until the period closes<template v-if="inv.currentMonth?.graceEndsAt">, with receipts accepted through {{ fmtDate(inv.currentMonth.graceEndsAt) }}</template>.
            </span>
          </div>
        </div>

        <div v-if="!inv.payouts.length" class="empty-msg">No past payouts yet.</div>
        <table v-else class="data-table">
          <thead>
            <tr>
              <th>Period</th>
              <th class="num">Amount</th>
              <th class="num">Adjustment</th>
              <th class="num">Adjusted total</th>
              <th>Due date</th>
              <th>Status</th>
              <th class="action-head"></th>
            </tr>
          </thead>
          <tbody>
            <template v-for="p in inv.payouts" :key="p.id">
            <tr>
              <!-- The period cell doubles as the expand control, so the movement log
                   costs no extra column. Offered only where there is something
                   behind it: historyCount comes from the server, so the console does
                   not have to fetch every row to find out which ones moved. -->
              <td class="mono">
                <button
                  v-if="p.historyCount"
                  type="button"
                  class="hist-toggle"
                  :aria-expanded="String(expandedId === p.id)"
                  :title="`${p.historyCount} recorded change${p.historyCount === 1 ? '' : 's'} to this amount`"
                  @click="toggleHistory(inv.ownerId, p)"
                >
                  <svg class="hist-chev" :class="{ open: expandedId === p.id }" viewBox="0 0 16 16" width="10" height="10" aria-hidden="true"><path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" /></svg>
                  {{ p.periodLabel }}
                  <span class="hist-count">{{ p.historyCount }}</span>
                </button>
                <template v-else>{{ p.periodLabel }}</template>
              </td>
              <!-- Amount / Adjustment / Adjusted total broken out, mirroring the
                   investor statement so both read the same arithmetic. -->
              <td class="num">{{ fmt(p.amount) }}</td>
              <!-- Applied delta, so Amount + Adjustment = Adjusted total holds. -->
              <td class="num">
                <span v-if="applied(p)" class="adj-badge" :title="adjTitle(p)">{{ applied(p) > 0 ? '+' : '−' }}{{ fmt(Math.abs(applied(p))) }}</span>
                <span v-else class="dim">&mdash;</span>
              </td>
              <td class="num"><span class="amt-main">{{ fmt(effective(p)) }}</span></td>
              <td class="dim">{{ fmtDate(p.dueDate) }}</td>
              <td>
                <span :class="['status-pill', statusClass(p.status)]">{{ p.status }}</span>
                <!-- A row walked back out of a settled state reads identically to
                     one that was never advanced. Mark it so the correction is
                     visible without digging through the audit trail. -->
                <span v-if="p.reopenedAt" class="reopened-flag" :title="reopenTitle(p)">reopened</span>
                <!-- Month is over but the books are still open for straggler
                     receipts. The figure is still moving, so nothing can be
                     settled yet — say why, and say until when.
                     ⚠️ "open through X", not "closes X": graceEndsAt is the last
                     day the books are open, INCLUSIVE, and the lock fires the
                     following morning. The old wording read a day early. -->
                <div v-if="p.phase === 'pending'" class="phase-note">
                  in final settlement &middot; open through {{ fmtDate(p.graceEndsAt) }}
                </div>
              </td>
              <td class="action-cell">
                <!-- Settling is blocked until the period closes. This is the whole
                     point of the window: marking paid on day 1 and then hand-
                     adjusting when a receipt lands on day 4 is the treadmill it
                     exists to end. Server enforces the same rule (409
                     PERIOD_NOT_FINALIZED) — this only avoids offering the click.

                     "Close now" USED TO RENDER HERE and was deliberately removed.
                     Closing is FLEET-WIDE (one carrier, one month-end), so it
                     appeared once per investor holding a row in that month with
                     every copy doing the identical thing — which reads as if it
                     were scoped to the investor whose table it sits in. Its single
                     home is the Month-Close Calendar above, which additionally
                     covers months that have no payout row at all. -->
                <template v-if="p.phase === 'pending'">
                  <span class="await-note">Nothing to do &mdash; settles when the month closes</span>
                </template>
                <template v-else>
                  <button
                    v-if="p.status === 'owed'"
                    type="button"
                    class="action-btn act-processing"
                    :disabled="busyId === p.id"
                    title="Move this payout from owed to processing"
                    @click="advance(p, 'processing')"
                  >Mark Processing</button>
                  <button
                    v-if="p.status !== 'paid'"
                    type="button"
                    class="action-btn act-paid"
                    :disabled="busyId === p.id"
                    title="Mark this payout as paid"
                    @click="confirmPaid(inv, p)"
                  >Mark Paid</button>
                <!-- Reopen a settled row. The correction path for a payout
                     advanced by mistake — without it, "Mark Paid" is one click
                     and permanently books money that may never have been sent. -->
                  <button
                    v-if="p.status !== 'owed'"
                    type="button"
                    class="action-btn act-reopen"
                    :disabled="busyId === p.id"
                    title="Move this payout back — it was advanced by mistake"
                    @click="openReopen(inv, p)"
                  >Reopen</button>
                  <!-- Adjust once the figure has stopped moving. Until the period
                       is finalized, `amount` is refreshed from live earnings on
                       every read, so a manual delta on top would be counted twice
                       and drift again on the next reconcile. Keyed on the PERIOD
                       (not the row's status) to match the server guard, which also
                       means a finalized-but-unpaid row IS adjustable — the
                       finalize -> correct -> pay flow. -->
                  <button
                    v-if="p.phase === 'finalized' || p.status !== 'owed'"
                    type="button"
                    class="action-btn act-adjust"
                    :disabled="busyId === p.id"
                    title="Add or edit a settlement adjustment (e.g. receipts that arrived after this month closed)"
                    @click="openAdjust(inv, p)"
                  >{{ p.adjustment ? 'Edit Adj.' : 'Adjust' }}</button>
                  <!-- "Reopen Month" USED TO RENDER HERE and was removed with
                       "Close now", for the same reason: it reopens the month for
                       EVERY investor, so offering it from inside one investor's
                       row misrepresented its blast radius. It lives in the
                       Month-Close Calendar above. The per-payout "Reopen" button
                       beside it is a different act and stays. -->
                </template>
              </td>
            </tr>
            <!-- Movement log. Same data the investor sees on their own portal, so
                 the two surfaces cannot tell different stories about the same
                 number. Sibling <tr>, so the table layout is untouched. -->
            <tr v-if="expandedId === p.id" class="hist-tr">
              <td :colspan="7" class="hist-cell">
                <div class="hist-panel">
                  <div class="hist-title">Changes to this amount</div>
                  <div v-if="histLoading" class="hist-empty">Loading…</div>
                  <ol v-else-if="histEntries.length" class="hist-list">
                    <li v-for="h in histEntries" :key="h.id" class="hist-row">
                      <span class="hist-when">{{ fmtTimestamp(h.changedAt) }}</span>
                      <span class="hist-what">
                        {{ h.detail || h.kind }}
                        <span v-if="h.delta" class="hist-delta" :class="h.delta > 0 ? 'hist-up' : 'hist-down'">
                          {{ h.delta > 0 ? '+' : '−' }}{{ fmt(Math.abs(h.delta)) }}
                        </span>
                        <span class="hist-actor">{{ h.actor }}</span>
                      </span>
                      <span v-if="h.why" class="hist-why">{{ h.why }}</span>
                    </li>
                  </ol>
                  <div v-else class="hist-empty">No changes recorded for this month.</div>
                </div>
              </td>
            </tr>
            </template>
          </tbody>
        </table>
      </section>
    </template>

    <!-- "Mark Paid" confirm. Paid is the one status that asserts money actually
         left the account, and it sits one click away from every unsettled row —
         so it asks first instead of booking a payment on a slip. -->
    <div v-if="payConfirm" class="adj-overlay" @click.self="closePayConfirm">
      <div class="adj-modal">
        <div class="adj-modal-title">Mark this payout as paid?</div>
        <div class="adj-modal-sub">
          {{ payConfirm.investorName }} · {{ payConfirm.payout.periodLabel }}
          <span :class="['status-pill', statusClass(payConfirm.payout.status)]">{{ payConfirm.payout.status }}</span>
        </div>
        <div class="adj-facts">
          <div class="adj-fact"><span>Amount</span><span class="mono">{{ fmt(effective(payConfirm.payout)) }}</span></div>
        </div>
        <p class="adj-hint pay-warn">
          Confirm the {{ fmt(effective(payConfirm.payout)) }} has actually been sent. This moves it into
          <strong>Total Paid</strong> and reports it to the investor as settled.
          <span v-if="payConfirm.payout.status === 'owed'">
            It also skips <strong>processing</strong> &mdash; if the transfer is only in flight, use
            <strong>Mark Processing</strong> instead.
          </span>
        </p>
        <div class="adj-actions">
          <button type="button" class="btn-ghost" :disabled="busyId" @click="closePayConfirm">Cancel</button>
          <button type="button" class="btn btn-primary" :disabled="busyId" @click="doPayConfirm">
            {{ busyId ? 'Saving…' : 'Yes, it was paid' }}
          </button>
        </div>
      </div>
    </div>

    <!-- Reopen modal — walk a settled payout backwards with a stated reason. -->
    <div v-if="reopenTarget" class="adj-overlay" @click.self="closeReopen">
      <div class="adj-modal">
        <div class="adj-modal-title">Reopen payout</div>
        <div class="adj-modal-sub">
          {{ reopenTarget.investorName }} · {{ reopenTarget.payout.periodLabel }}
          <span :class="['status-pill', statusClass(reopenTarget.payout.status)]">{{ reopenTarget.payout.status }}</span>
        </div>

        <div class="adj-facts">
          <div class="adj-fact"><span>Settled amount</span><span class="mono">{{ fmt(effective(reopenTarget.payout)) }}</span></div>
          <div v-if="reopenTarget.payout.paidAt" class="adj-fact">
            <span>Marked paid</span><span class="mono">{{ fmtDate(reopenTarget.payout.paidAt) }}</span>
          </div>
        </div>

        <label class="adj-label">Move it back to</label>
        <div class="reopen-choices">
          <label v-for="opt in reopenOptions" :key="opt.value" class="reopen-choice">
            <input type="radio" :value="opt.value" v-model="reopenStatus" />
            <span>
              <strong>{{ opt.label }}</strong>
              <em>{{ opt.hint }}</em>
            </span>
          </label>
        </div>

        <label class="adj-label">Reason (required)</label>
        <textarea
          v-model="reopenReason"
          class="adj-textarea"
          rows="2"
          maxlength="500"
          placeholder="e.g. Marked paid in error — transfer was never sent, still processing"
        ></textarea>

        <div class="adj-actions">
          <button type="button" class="btn-ghost" :disabled="reopenSaving" @click="closeReopen">Cancel</button>
          <button type="button" class="btn btn-primary" :disabled="reopenSaving || !reopenReason.trim()" @click="saveReopen">
            {{ reopenSaving ? 'Saving…' : 'Reopen payout' }}
          </button>
        </div>
      </div>
    </div>

    <!-- Close-the-month confirm. Fleet-wide and one-way-ish: it freezes every
         investor's figure for the period and publishes their statements, so it
         asks first even though the sweep would do the same thing on its own. -->
    <div v-if="finalizeTarget" class="adj-overlay" @click.self="closeFinalize">
      <div class="adj-modal">
        <div class="adj-modal-title">Close {{ finalizeTarget.periodLabel }}</div>
        <div class="adj-modal-sub">Final settlement &mdash; all investors</div>

        <div class="adj-facts">
          <div class="adj-fact">
            <span>Would close on its own</span><span class="mono">{{ fmtDate(finalizeTarget.graceEndsAt) }}</span>
          </div>
        </div>

        <p class="adj-hint pay-warn">
          Closing now freezes <strong>every investor's</strong> {{ finalizeTarget.periodLabel }} figure and publishes
          their statements. Receipts dated in {{ finalizeTarget.periodLabel }} that arrive afterwards will be booked
          to the current open month instead.
          <br /><br />
          Only do this if every receipt for {{ finalizeTarget.periodLabel }} is already in.
        </p>

        <div class="adj-actions">
          <button type="button" class="btn-ghost" :disabled="periodSaving" @click="closeFinalize">Cancel</button>
          <button type="button" class="btn btn-primary" :disabled="periodSaving" @click="savePeriodFinalize">
            {{ periodSaving ? 'Closing…' : 'Close the month' }}
          </button>
        </div>
      </div>
    </div>

    <!-- Reopen the whole month. Distinct from reopening one payout row: this
         puts the period back in "receipts still count" state for everyone. -->
    <div v-if="periodReopenTarget" class="adj-overlay" @click.self="closePeriodReopen">
      <div class="adj-modal">
        <div class="adj-modal-title">Reopen {{ periodReopenTarget.periodLabel }}</div>
        <div class="adj-modal-sub">Reopens the month for all investors</div>

        <p class="adj-hint">
          Still-owed payouts go back to tracking live earnings, so new receipts dated in
          {{ periodReopenTarget.periodLabel }} will count again. Payouts already marked
          <strong>processing</strong> or <strong>paid</strong> keep their settled figure &mdash; their statements
          have already gone out.
          <br /><br />
          Receipts that were redirected to a later month while this one was closed <strong>stay there</strong>:
          pulling them back would move two months at once.
        </p>

        <label class="adj-label">Reason (required)</label>
        <textarea
          v-model="periodReopenReason"
          class="adj-textarea"
          rows="2"
          maxlength="500"
          placeholder="e.g. A stack of fuel receipts for the month arrived late from the terminal"
        ></textarea>

        <div class="adj-actions">
          <button type="button" class="btn-ghost" :disabled="periodSaving" @click="closePeriodReopen">Cancel</button>
          <button type="button" class="btn btn-primary" :disabled="periodSaving || !periodReopenReason.trim()" @click="savePeriodReopen">
            {{ periodSaving ? 'Saving…' : 'Reopen the month' }}
          </button>
        </div>
      </div>
    </div>

    <!-- Settlement adjustment modal -->
    <div v-if="adjustTarget" class="adj-overlay" @click.self="closeAdjust">
      <div class="adj-modal">
        <div class="adj-modal-title">Adjust payout</div>
        <div class="adj-modal-sub">
          {{ adjustTarget.investorName }} · {{ adjustTarget.payout.periodLabel }}
          <span :class="['status-pill', statusClass(adjustTarget.payout.status)]">{{ adjustTarget.payout.status }}</span>
        </div>

        <div class="adj-facts">
          <div class="adj-fact"><span>Settled amount</span><span class="mono">{{ fmt(adjustTarget.payout.amount) }}</span></div>
          <div v-if="hasGap" class="adj-fact gap">
            <span>Recomputed now</span>
            <span class="mono">{{ fmt(adjustTarget.payout.recomputedAmount) }} <em>(gap {{ gapDelta > 0 ? '+' : '−' }}{{ fmt(Math.abs(gapDelta)) }})</em></span>
          </div>
        </div>
        <p v-if="hasGap" class="adj-hint">
          This period now recomputes {{ gapDelta < 0 ? 'lower' : 'higher' }} than what was settled — likely the late
          receipts. Use the suggested adjustment to bring the record in line.
          <button type="button" class="adj-suggest" @click="applySuggestion">Use {{ gapDelta > 0 ? '+' : '−' }}{{ fmt(Math.abs(gapDelta)) }}</button>
        </p>

        <label class="adj-label">Adjustment (+ credits investor, − claws back)</label>
        <input v-model="adjustAmount" type="number" step="0.01" class="adj-input" placeholder="0.00" />

        <label class="adj-label">Reason (shown to the investor)</label>
        <textarea v-model="adjustNote" class="adj-textarea" rows="2" maxlength="500" placeholder="e.g. Late June fuel receipts uploaded after settlement"></textarea>

        <div class="adj-preview">
          New effective payout: <strong class="mono" :class="{ 'adj-over': overDeducted }">{{ fmt(previewEffective) }}</strong>
        </div>
        <div v-if="overDeducted" class="adj-warn">
          A payout can be reduced to $0 but not below. The largest deduction for this
          period is <strong class="mono">−{{ fmt(maxDeduction) }}</strong>.
        </div>

        <div class="adj-actions">
          <button type="button" class="btn-ghost" :disabled="adjustSaving" @click="closeAdjust">Cancel</button>
          <button type="button" class="btn btn-primary" :disabled="adjustSaving || overDeducted" @click="saveAdjust">{{ adjustSaving ? 'Saving…' : 'Save adjustment' }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { formatCurrency as fmt } from '../utils/format'
import { useApi } from '../composables/useApi'
import { useAuthStore } from '../stores/auth'
import { useToast } from '../composables/useToast'
import { fmtYmd, fmtTimestamp, parseYmdLocal } from '../utils/datetime'

const api = useApi()
// Pulled in for parity with the other admin pages; auth gating is enforced by
// the router guard, but having the store here keeps the surface consistent and
// available for future per-row checks.
useAuthStore()
const { show: toast } = useToast()

const loading = ref(true)
// A load failure shouldn't blank the whole admin page. We flip loadFailed and
// render a graceful fallback; notFound distinguishes a 404 (endpoint not built
// yet → empty-state copy) from any other error (generic, retryable message).
const loadFailed = ref(false)
const notFound = ref(false)
const errorMsg = ref('')
const busyId = ref(null)

// ---------------------------------------------------------------------------
// Movement log. Reads the SAME endpoint the investor portal reads, so the console
// and the investor can never be shown different stories about one number.
//
// Single-open accordion, and fetched on expand rather than with the table: this
// page already loops every settlable investor and re-fetches after every mutation,
// so eagerly loading history for every row would multiply that by the row count
// for data almost nobody opens.
// ---------------------------------------------------------------------------
const expandedId = ref(null)
const histEntries = ref([])
const histLoading = ref(false)

const MOVE_LABELS = {
  revenue: 'revenue', driverPay: 'driver pay', fixedCosts: 'fixed costs',
  tripExpenses: 'trip expenses', maintFundCost: 'maintenance fund', complianceCost: 'compliance',
}
// What moved, by diffing a snapshot against the next OLDER one — never recomputed,
// so the explanation always reconciles with the figures beside it. Entries arrive
// newest-first, hence i + 1. Returns '' for the oldest entry, which has nothing
// behind it to compare against; saying nothing beats inventing a cause.
function describeMove(now, prev) {
  if (!now || !prev) return ''
  return Object.keys(MOVE_LABELS)
    .map((k) => ({ k, d: Number(now[k] || 0) - Number(prev[k] || 0) }))
    .filter((x) => Math.abs(x.d) >= 0.01)
    .sort((a, b) => Math.abs(b.d) - Math.abs(a.d))
    .map((x) => `${MOVE_LABELS[x.k]} ${x.d > 0 ? '+' : '−'}${fmt(Math.abs(x.d))}`)
    .join(' · ')
}

async function toggleHistory(ownerId, p) {
  if (expandedId.value === p.id) { expandedId.value = null; return }
  expandedId.value = p.id
  histEntries.value = []
  histLoading.value = true
  try {
    // as_user_id is REQUIRED here: the endpoint refuses an unscoped Super Admin
    // session rather than guessing whose payouts are being read.
    const r = await api.get(`/api/investor/payouts/${encodeURIComponent(p.period)}/history?as_user_id=${encodeURIComponent(ownerId)}`)
    histEntries.value = (r?.entries || []).map((e, i, all) => ({ ...e, why: describeMove(e.breakdown, all[i + 1]?.breakdown) }))
  } catch {
    histEntries.value = []
  } finally {
    histLoading.value = false
  }
}

const investors = ref([])
const monthlyTotals = ref([])
const grandTotals = ref({ totalOwed: 0, totalProcessing: 0, totalPaid: 0 })

const STATUS_CLASS = { owed: 'st-owed', processing: 'st-processing', paid: 'st-paid' }
function statusClass(s) {
  return STATUS_CLASS[s] || 'st-owed'
}

// MIXED INPUT: dueDate/graceEndsAt are bare 'YYYY-MM-DD' (new Date() would render
// the previous day in Houston), paidAt/reopenedAt are ISO instants that should
// convert to the viewer's zone. fmtYmd branches on the shape.
const fmtDate = (d) => fmtYmd(d)

async function loadPayouts() {
  loading.value = true
  try {
    const data = await api.get('/api/payouts')
    investors.value = data.investors || []
    monthlyTotals.value = data.monthlyTotals || []
    grandTotals.value = data.grandTotals || { totalOwed: 0, totalProcessing: 0, totalPaid: 0 }
    loadFailed.value = false
    notFound.value = false
    errorMsg.value = ''
  } catch (err) {
    // Degrade gracefully. A 404 means the endpoint isn't serving yet (it's
    // being built in parallel) → empty state; anything else is a genuine load
    // error with a distinct, retryable message.
    investors.value = []
    monthlyTotals.value = []
    grandTotals.value = { totalOwed: 0, totalProcessing: 0, totalPaid: 0 }
    loadFailed.value = true
    notFound.value = err.status === 404
    errorMsg.value = err.message || ''
  }
  loading.value = false
}

// ---------------------------------------------------------------------------
// Month-close calendar — GET /api/periods.
//
// The client asked "is there anything specific I have to do to close out the
// previous one within the 7 day window?" The answer is no: a per-minute sweep
// locks the month on its own once the grace window elapses, and production shows
// every closed period stamped by `system`. Nothing in the app said so, because
// this console only ever rendered payout rows and the close lifecycle had to be
// inferred from them.
//
// This endpoint is the ONLY source for four things /api/payouts cannot answer:
// WHO closed a month (`system` vs a username), how long the grace window is,
// whether automatic close is switched on at all, and months that carry no payout
// row — which the per-investor tables structurally cannot show.
//
// ⚠️ IT FAILS DIFFERENTLY FROM /api/payouts, ON PURPOSE. It 500s when
// period_locks is malformed rather than fabricating a close calendar, while
// /api/payouts degrades with a flag. So this panel owns its own loading/error
// state and never touches the page-level `loadFailed` — a broken calendar must
// not blank the settlement console.
// ---------------------------------------------------------------------------
const periods = ref([])
const graceDays = ref(0)
const closeEnabled = ref(false)
const currentPeriod = ref('')
const backfill = ref(null)
const periodsLoading = ref(true)
const periodsFailed = ref(false)
const periodsErrorMsg = ref('')

async function loadPeriods() {
  periodsLoading.value = true
  try {
    const data = await api.get('/api/periods')
    periods.value = Array.isArray(data.periods) ? data.periods : []
    graceDays.value = Number.isFinite(Number(data.graceDays)) ? Number(data.graceDays) : 0
    closeEnabled.value = !!data.enabled
    currentPeriod.value = data.currentPeriod || ''
    backfill.value = data.legacyExpenseBackfill || null
    periodsFailed.value = false
    periodsErrorMsg.value = ''
  } catch (err) {
    // Drop the authoritative data — a stale calendar shown as current is worse
    // than a named gap — and let calendarRows fall through to the reconstruction.
    periods.value = []
    backfill.value = null
    periodsFailed.value = true
    periodsErrorMsg.value = err.message || ''
  }
  periodsLoading.value = false
}

// Reduced calendar rebuilt from the payout rows already loaded, used only when
// /api/periods is unavailable. This is exactly the data the per-investor "Close
// now" / "Reopen Month" buttons ran on before they were consolidated here, so
// removing them costs no capability in the degraded state: period / periodLabel
// / graceEndsAt are all the modals and save handlers ever read.
//
// What it genuinely cannot reconstruct — and what the warning banner therefore
// names out loud — is finalizedBy, graceDays, the enabled flag, and any month
// with no payout row.
const fallbackPeriods = computed(() => {
  const seen = new Map()
  const put = (p) => {
    if (!p || !p.period || seen.has(p.period)) return
    seen.set(p.period, {
      period: p.period,
      periodLabel: p.periodLabel || p.period,
      phase: p.phase || '',
      graceEndsAt: p.graceEndsAt || '',
      finalizedAt: '',
      finalizedBy: '',
    })
  }
  for (const inv of investors.value) {
    put(inv.currentMonth)
    for (const p of inv.payouts || []) put(p)
  }
  return [...seen.values()].sort((a, b) => (a.period < b.period ? 1 : -1))
})

const calendarRows = computed(() => (periodsFailed.value ? fallbackPeriods.value : periods.value))
const closeMode = computed(() => (periodsFailed.value ? 'unknown' : closeEnabled.value ? 'auto' : 'manual'))
const closedCount = computed(() => calendarRows.value.filter((r) => r.phase === 'finalized').length)
// `system` is the sweep's actor, so this is literally "how many closed with
// nobody clicking" — the evidence behind the headline claim.
const autoClosedCount = computed(
  () => calendarRows.value.filter((r) => r.phase === 'finalized' && r.finalizedBy === 'system').length
)
const backfillBlocked = computed(() => {
  const b = backfill.value
  return !!b && (Number(b.skippedLockedPeriod) > 0 || !!b.error)
})

const PHASE_META = {
  accruing: { cls: 'st-progress', label: 'accruing', hint: 'Still running. Revenue and receipts are still landing in this month.' },
  pending: { cls: 'st-owed', label: 'open for receipts', hint: 'The month has ended, but the books are still open for late receipts. It closes on its own when the window runs out.' },
  finalized: { cls: 'st-paid', label: 'closed', hint: 'Figures are frozen and statements are published. Receipts dated in this month now post to the current open month instead.' },
}
// '' arrives when the server can't put the month in the lifecycle — in practice
// because period close is switched off (a malformed period_locks 500s the route
// instead). Say "open" and explain, rather than inventing a phase.
function phaseMeta(r) {
  return PHASE_META[r && r.phase] || {
    cls: 'st-owed',
    label: 'open',
    hint: 'No scheduled close — automatic month-close is not running on this server.',
  }
}

function finalizedByLabel(r) {
  const who = (r && r.finalizedBy) || ''
  if (!who) return ''
  return who === 'system' ? 'automatically' : `by ${who}`
}

function noActionNote(r) {
  if (r && r.phase === 'accruing') return 'Still running'
  return ''
}

function periodReopenTitle(r) {
  const who = r.reopenedBy ? ` by ${r.reopenedBy}` : ''
  const when = r.reopenedAt ? ` on ${fmtDate(r.reopenedAt)}` : ''
  return `Month reopened${who}${when}${r.reopenReason ? ` — ${r.reopenReason}` : ''}`
}

// ⚠️ graceEndsAt is the LAST day the books are open, INCLUSIVE — '2026-08-07'
// means all of Aug 7, with the lock firing at the start of Aug 8. Rendering the
// grace date itself as "closes on" is off by one in the direction that loses a
// receipt someone was told they still had time to file, so the UI prints both
// dates and this derives the second.
//
// parseYmdLocal builds a LOCAL-midnight Date deliberately: new Date('YYYY-MM-DD')
// is UTC midnight and renders as the previous day anywhere behind UTC, which is
// the exact bug utils/datetime exists to prevent.
function dayAfter(ymd) {
  const d = parseYmdLocal(ymd)
  if (!d) return ''
  d.setDate(d.getDate() + 1)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
function closesOn(graceEndsAt) {
  const next = dayAfter(graceEndsAt)
  return next ? fmtDate(next) : ''
}

// Both surfaces after every mutation, so the calendar and the payout tables can
// never tell different stories about the same month. SEQUENTIAL, not parallel:
// GET /api/payouts runs the reconcile that can mint a payout row for a newly
// rolled-over month, and /api/periods derives its open months from those rows —
// racing them would let the calendar miss a period that had just appeared.
async function refreshAll() {
  await loadPayouts()
  await loadPeriods()
}

async function advance(payout, status) {
  if (busyId.value) return
  busyId.value = payout.id
  try {
    await api.post(`/api/investor/payouts/${payout.id}/status`, { status })
    toast(status === 'paid' ? 'Payout marked paid' : 'Payout marked processing')
    await refreshAll()
  } catch (err) {
    toast(err.message || 'Failed to update payout', 'error')
  } finally {
    busyId.value = null
  }
}

// --- "Mark Paid" confirm -----------------------------------------------------
// Paid is the only status that claims money actually moved, and it renders one
// click away on every unsettled row. A slip here books a payment that never
// happened and reports it to the investor as settled, so it confirms first.
const payConfirm = ref(null)   // { investorName, payout }

function confirmPaid(inv, p) {
  payConfirm.value = { investorName: inv.name, payout: p }
}
function closePayConfirm() {
  payConfirm.value = null
}
async function doPayConfirm() {
  const t = payConfirm.value
  if (!t) return
  await advance(t.payout, 'paid')
  payConfirm.value = null
}

// --- Reopen ------------------------------------------------------------------
// The correction path for a payout advanced by mistake. Reopening to
// 'processing' keeps the settled amount frozen; going back to 'owed' re-links
// the row to live earnings, so the server will refresh its amount on the next
// reconcile — surfaced in the option hints so the choice is informed.
const reopenTarget = ref(null)   // { investorName, payout }
const reopenStatus = ref('processing')
const reopenReason = ref('')
const reopenSaving = ref(false)

const reopenOptions = computed(() => {
  const opts = []
  if (reopenTarget.value?.payout.status === 'paid') {
    opts.push({ value: 'processing', label: 'Processing', hint: 'Payment is in flight but not settled. Amount stays frozen.' })
  }
  opts.push({ value: 'owed', label: 'Owed', hint: 'Back to unsettled. Amount re-links to live earnings and will refresh.' })
  return opts
})

function reopenTitle(p) {
  const who = p.reopenedBy ? ` by ${p.reopenedBy}` : ''
  const when = p.reopenedAt ? ` on ${fmtDate(p.reopenedAt)}` : ''
  return `Reopened${who}${when}${p.reopenReason ? ` — ${p.reopenReason}` : ''}`
}

// --- Month close / reopen ----------------------------------------------------
// These act on the PERIOD, not on one payout row: a month is open or closed for
// every investor at once. Closing normally happens by itself once the grace
// window elapses; these are the "everything's in, close it now" and "we got that
// wrong" overrides.
const finalizeTarget = ref(null)        // a payout row, used only for its period
const periodReopenTarget = ref(null)
const periodReopenReason = ref('')
const periodSaving = ref(false)

function openFinalize(p) { finalizeTarget.value = p }
function closeFinalize() { finalizeTarget.value = null }
function openPeriodReopen(p) { periodReopenTarget.value = p; periodReopenReason.value = '' }
function closePeriodReopen() { periodReopenTarget.value = null; periodReopenReason.value = '' }

async function savePeriodFinalize() {
  const t = finalizeTarget.value
  if (!t || periodSaving.value) return
  periodSaving.value = true
  try {
    const r = await api.post(`/api/periods/${t.period}/finalize`)
    toast(`${t.periodLabel} closed — ${r.stamped} payout(s) frozen, statements published`)
    finalizeTarget.value = null
    await refreshAll()
  } catch (err) {
    toast(err.message || 'Failed to close the month', 'error')
  } finally {
    periodSaving.value = false
  }
}

async function savePeriodReopen() {
  const t = periodReopenTarget.value
  const reason = periodReopenReason.value.trim()
  if (!t || !reason || periodSaving.value) return
  periodSaving.value = true
  try {
    const r = await api.post(`/api/periods/${t.period}/reopen`, { reason })
    // Surface what reopening did NOT undo rather than letting it be discovered
    // later: receipts already booked to a later month stay there.
    toast(r.note || `${t.periodLabel} reopened`, r.divertedReceipts ? 'warning' : 'success')
    periodReopenTarget.value = null
    periodReopenReason.value = ''
    await refreshAll()
  } catch (err) {
    toast(err.message || 'Failed to reopen the month', 'error')
  } finally {
    periodSaving.value = false
  }
}

function openReopen(inv, p) {
  reopenTarget.value = { investorName: inv.name, payout: p }
  // Default to the smallest walk-back: paid → processing, processing → owed.
  reopenStatus.value = p.status === 'paid' ? 'processing' : 'owed'
  reopenReason.value = ''
}
function closeReopen() {
  reopenTarget.value = null
  reopenSaving.value = false
}
async function saveReopen() {
  const t = reopenTarget.value
  const reason = reopenReason.value.trim()
  if (!t || !reason || reopenSaving.value) return
  reopenSaving.value = true
  try {
    await api.post(`/api/investor/payouts/${t.payout.id}/status`, {
      status: reopenStatus.value,
      reason,
    })
    toast(`Payout reopened as ${reopenStatus.value}`)
    reopenTarget.value = null
    await refreshAll()
  } catch (err) {
    toast(err.message || 'Failed to reopen payout', 'error')
  } finally {
    reopenSaving.value = false
  }
}

// --- Settlement adjustments (e.g. receipts uploaded after a month settled) ---
const adjustTarget = ref(null)   // { investorName, payout }
const adjustAmount = ref('')
const adjustNote = ref('')
const adjustSaving = ref(false)

// effectiveAmount is amount + adjustment (server-computed); fall back defensively.
function effective(p) {
  return p.effectiveAmount != null ? p.effectiveAmount : (p.amount || 0)
}

// The delta that actually landed. A payout clamps at $0, so an over-deduction
// (only possible on rows written before the guard) shows what really applied.
function applied(p) {
  return p.adjustmentApplied != null ? p.adjustmentApplied : (p.adjustment || 0)
}
function adjTitle(p) {
  const who = p.adjustedBy ? ` — ${p.adjustedBy}` : ''
  return `${p.adjustmentNote || 'Adjustment'}${who}`
}

// Gap between what the period recomputes at now and what was settled — the
// signal that late receipts moved the number after the fact.
const gapDelta = computed(() => {
  const p = adjustTarget.value?.payout
  if (!p || p.recomputedAmount == null) return 0
  return p.recomputedAmount - p.amount
})
const hasGap = computed(() => gapDelta.value !== 0)
const previewEffective = computed(() => {
  const p = adjustTarget.value?.payout
  if (!p) return 0
  const amt = Number(adjustAmount.value)
  return (p.amount || 0) + (Number.isFinite(amt) ? amt : 0)
})
// A payout can be reduced to nothing but never inverted — the server rejects an
// over-deduction (400), so warn in the modal instead of letting the admin type a
// number, hit Save and only then find out.
const overDeducted = computed(() => previewEffective.value < 0)
const maxDeduction = computed(() => Math.max(0, Number(adjustTarget.value?.payout?.amount || 0)))

function openAdjust(inv, p) {
  adjustTarget.value = { investorName: inv.name, payout: p }
  if (p.adjustment) {
    // Editing an existing adjustment.
    adjustAmount.value = String(p.adjustment)
    adjustNote.value = p.adjustmentNote || ''
  } else {
    // Suggest the recompute gap as a starting delta; admin confirms/edits.
    adjustAmount.value = (p.recomputedAmount != null && p.recomputedAmount !== p.amount)
      ? String(p.recomputedAmount - p.amount) : ''
    adjustNote.value = ''
  }
}
function closeAdjust() {
  adjustTarget.value = null
  adjustSaving.value = false
}
function applySuggestion() {
  adjustAmount.value = String(gapDelta.value)
}
async function saveAdjust() {
  const t = adjustTarget.value
  if (!t) return
  const amt = Number(adjustAmount.value)
  if (!Number.isFinite(amt)) { toast('Enter a valid adjustment amount', 'error'); return }
  if (Math.abs(amt) > 10000) { toast('Adjustment is capped at $10,000', 'error'); return }
  adjustSaving.value = true
  try {
    await api.put(`/api/investor/payouts/${t.payout.id}/adjust`, {
      adjustment: amt,
      adjustmentNote: adjustNote.value,
    })
    toast('Adjustment saved')
    adjustTarget.value = null
    await refreshAll()
  } catch (err) {
    toast(err.message || 'Failed to save adjustment', 'error')
  } finally {
    adjustSaving.value = false
  }
}

onMounted(refreshAll)
</script>

<style scoped>
/* .admin-page (shared.css) supplies the flex-column page frame; .main applies
   the shared page padding. Only page-specific spacing lives here. */
.payouts-page {
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

.empty {
  padding: 3rem 1rem;
  text-align: center;
  background: var(--surface);
  border: 1px dashed var(--border);
  border-radius: var(--radius);
  color: var(--text-dim);
  font-size: 0.9rem;
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
}
.section-sub {
  margin-left: auto;
  font-size: 0.72rem;
  font-weight: 500;
  color: var(--text-dim);
}

/* Grand totals */
.totals-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 0.75rem;
}
.total-card {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 0.85rem 1rem;
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}
.total-card.amber { border-left: 3px solid var(--amber); }
.total-card.blue { border-left: 3px solid var(--blue); }
.total-card.green { border-left: 3px solid #16a34a; }
.total-label {
  font-size: 0.66rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-dim);
}
.total-value {
  font-size: 1.3rem;
  font-weight: 800;
}
.total-card.amber .total-value { color: #b45309; }
.total-card.blue .total-value { color: #0369a1; }
.total-card.green .total-value { color: #166534; }

/* Tables */
.data-table {
  width: 100%;
  border-collapse: separate;
  border-spacing: 0;
  font-size: 0.82rem;
}
.data-table th {
  text-align: left;
  padding: 0.5rem 0.5rem;
  font-weight: 600;
  color: var(--text-dim);
  border-bottom: 2px solid var(--border);
  font-size: 0.68rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  user-select: none;
}
.data-table th.num { text-align: right; }
.data-table th.action-head { text-align: right; }
.data-table td {
  padding: 0.6rem 0.5rem;
  border-bottom: 1px solid var(--bg);
  vertical-align: middle;
}
.data-table tbody tr:hover { background: var(--bg); }
.data-table td.num {
  text-align: right;
  font-family: 'JetBrains Mono', monospace;
}
.data-table td.mono {
  font-family: 'JetBrains Mono', monospace;
  font-weight: 600;
}
.data-table td.dim { color: var(--text-dim); }
.data-table td.amber { color: #b45309; }
.data-table td.blue { color: #0369a1; }
.data-table td.green { color: #166534; }
.data-table td.strong { font-weight: 700; }
.monthly-table td.num { font-weight: 600; }

/* Current-month accrual card */
.current-card {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 1rem 1.25rem;
  margin-bottom: 1rem;
}
.current-main {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.75rem;
  flex-wrap: wrap;
}
.current-label {
  font-size: 0.9rem;
  font-weight: 700;
  color: var(--text);
}
.current-amount {
  font-size: 1.35rem;
  font-weight: 800;
  color: var(--text);
}
.current-meta {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  margin-top: 0.6rem;
  flex-wrap: wrap;
}
.current-note {
  font-size: 0.74rem;
  color: var(--text-dim);
  font-style: italic;
}
.mono { font-family: 'JetBrains Mono', monospace; }

.empty-msg {
  text-align: center;
  color: var(--text-dim);
  font-size: 0.85rem;
  padding: 1.5rem 0;
}

/* Status pills — same palette as PayoutsSection */
.status-pill {
  display: inline-block;
  font-size: 0.66rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  padding: 0.2rem 0.55rem;
  border-radius: 10px;
  white-space: nowrap;
}
.status-pill.st-owed { background: #fef3c7; color: #92400e; }
.status-pill.st-processing { background: #dbeafe; color: #1e40af; }
.status-pill.st-paid { background: #dcfce7; color: #166534; }
.status-pill.st-progress { background: #dbeafe; color: #1e40af; }

/* Row actions */
.action-cell {
  text-align: right;
  white-space: nowrap;
}
.action-btn {
  font: inherit;
  font-size: 0.72rem;
  font-weight: 600;
  padding: 0.3rem 0.65rem;
  border-radius: 6px;
  border: 1px solid transparent;
  cursor: pointer;
  margin-left: 0.4rem;
  transition: all 0.15s;
}
.action-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.act-processing { background: #dbeafe; color: #1e40af; }
.act-processing:hover:not(:disabled) { background: #bfdbfe; }
.act-paid { background: #dcfce7; color: #166534; }
.act-paid:hover:not(:disabled) { background: #bbf7d0; }
.act-adjust { background: #ede9fe; color: #5b21b6; }
.act-adjust:hover:not(:disabled) { background: #ddd6fe; }
/* Amber — a correction, not a normal step forward through the lifecycle. */
.act-reopen { background: #fef3c7; color: #92400e; }
.act-reopen:hover:not(:disabled) { background: #fde68a; }
/* Slate — closing the month is an administrative act on the whole period, not a
   step in one payout's lifecycle, so it reads differently from the pills above. */
.act-finalize { background: #e2e8f0; color: #334155; }
.act-finalize:hover:not(:disabled) { background: #cbd5e1; }
.act-reopen-period { background: #fef3c7; color: #92400e; }
.act-reopen-period:hover:not(:disabled) { background: #fde68a; }

/* A month still inside its grace window: the figure is live, not settled. */
.phase-note {
  margin-top: 0.25rem;
  font-size: 0.68rem;
  color: var(--amber);
  white-space: nowrap;
}
.await-note {
  font-size: 0.68rem;
  color: var(--text-dim, #64748b);
  margin-right: 0.4rem;
  white-space: nowrap;
}

/* --- Month-close calendar -------------------------------------------------
   The headline answer reads as a statement, not a widget: it is the whole
   reason the section exists ("do I need to do anything?" → "no"). */
.close-answer {
  border-radius: 10px;
  padding: 0.8rem 1rem;
  margin-bottom: 1rem;
  border: 1px solid var(--border);
  border-left-width: 3px;
}
.close-answer.auto { background: #f0fdf4; border-color: #bbf7d0; border-left-color: #16a34a; }
.close-answer.manual { background: #fffbeb; border-color: #fde68a; border-left-color: #d97706; }
.close-answer.unknown { background: var(--bg); border-left-color: var(--text-dim, #64748b); }
.ca-title { font-size: 0.9rem; font-weight: 700; margin-bottom: 0.3rem; }
.close-answer.auto .ca-title { color: #166534; }
.close-answer.manual .ca-title { color: #92400e; }
.ca-body {
  margin: 0;
  font-size: 0.78rem;
  line-height: 1.5;
  color: var(--text, #1f2937);
}
.ca-body + .ca-body { margin-top: 0.4rem; }
.ca-body.dim { color: var(--text-dim, #64748b); }
.mono-inline {
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.92em;
  background: rgba(0, 0, 0, 0.05);
  border-radius: 4px;
  padding: 0 0.25rem;
}

.calendar-warn {
  background: #fffbeb;
  border: 1px solid #fde68a;
  border-radius: 8px;
  padding: 0.6rem 0.75rem;
  font-size: 0.78rem;
  line-height: 1.5;
  color: #92400e;
  margin-bottom: 0.75rem;
}
.calendar-retry {
  font: inherit;
  font-size: 0.75rem;
  font-weight: 700;
  background: none;
  border: 0;
  padding: 0;
  margin-left: 0.35rem;
  color: #92400e;
  text-decoration: underline;
  cursor: pointer;
}
.backfill-warn { margin-top: 0.75rem; margin-bottom: 0; }
.bf-periods { font-family: 'JetBrains Mono', monospace; font-weight: 600; }
.bf-how { display: block; margin-top: 0.3rem; }
.bf-error { margin-top: 0.4rem; font-weight: 600; }
.bf-meta { margin-top: 0.4rem; font-size: 0.72rem; opacity: 0.8; }

/* Five columns of dates on a phone: scroll rather than wrap, so the months stay
   in one readable column. */
.calendar-scroll { overflow-x: auto; -webkit-overflow-scrolling: touch; }
.calendar-table { min-width: 620px; }
.calendar-table .status-pill[title],
.calendar-table .reopened-flag[title] { cursor: help; }
.calendar-table .grace-day { display: block; color: var(--text, #1f2937); }
.calendar-table .grace-sub,
.calendar-table .closed-by {
  display: block;
  font-size: 0.68rem;
  color: var(--text-dim, #64748b);
  margin-top: 0.1rem;
}
.calendar-table .closed-on { display: block; color: var(--text, #1f2937); }
.cur-flag {
  margin-left: 0.4rem;
  font-size: 0.62rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: #1e40af;
  background: #dbeafe;
  border-radius: 0.25rem;
  padding: 0.1rem 0.3rem;
}

.reopened-flag {
  margin-left: 0.4rem;
  font-size: 0.65rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  color: #92400e;
  background: #fef3c7;
  border-radius: 0.25rem;
  padding: 0.1rem 0.3rem;
  cursor: help;
}

.reopen-choices { display: flex; flex-direction: column; gap: 0.5rem; }
.reopen-choice {
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
  padding: 0.55rem 0.65rem;
  border: 1px solid var(--border, #e5e7eb);
  border-radius: 0.5rem;
  cursor: pointer;
  font-size: 0.82rem;
}
.reopen-choice:hover { background: #f9fafb; }
.reopen-choice input { margin-top: 0.15rem; }
.reopen-choice strong { display: block; font-weight: 600; }
.reopen-choice em {
  display: block;
  font-style: normal;
  font-size: 0.74rem;
  color: var(--text-dim);
  margin-top: 0.1rem;
}

.pay-warn { color: #92400e; background: #fffbeb; border-radius: 0.4rem; padding: 0.5rem 0.6rem; }

/* Adjustment indicator on the amount cell */
.amt-main { font-weight: 600; }
.adj-badge {
  display: inline-block; margin-left: 0.4rem; padding: 0.1rem 0.4rem;
  font-size: 0.66rem; font-weight: 700; border-radius: 5px;
  background: #fef3c7; color: #92400e; cursor: help; white-space: nowrap;
}

/* Adjustment modal */
.adj-overlay {
  position: fixed; inset: 0; background: rgba(0, 0, 0, 0.5);
  display: flex; align-items: center; justify-content: center; z-index: 1000; padding: 1rem;
}
.adj-modal {
  background: var(--surface, #fff); border: 1px solid var(--border, #e5e7eb);
  border-radius: 12px; padding: 1.25rem; width: 100%; max-width: 440px;
  display: flex; flex-direction: column; gap: 0.55rem;
  box-shadow: 0 10px 40px rgba(0, 0, 0, 0.25);
}
.adj-modal-title { font-size: 1.05rem; font-weight: 700; }
.adj-modal-sub { font-size: 0.82rem; color: var(--text-dim, #6b7280); display: flex; align-items: center; gap: 0.5rem; }
.adj-facts { display: flex; flex-direction: column; gap: 0.3rem; padding: 0.5rem 0; border-top: 1px solid var(--border); border-bottom: 1px solid var(--border); }
.adj-fact { display: flex; justify-content: space-between; font-size: 0.82rem; }
.adj-fact.gap { color: #b45309; }
.adj-fact em { font-style: normal; opacity: 0.8; }
.adj-hint { font-size: 0.78rem; color: var(--text-dim); margin: 0; line-height: 1.45; }
.adj-suggest {
  background: none; border: none; color: var(--accent, #6d28d9); font: inherit;
  font-size: 0.78rem; font-weight: 700; text-decoration: underline; cursor: pointer; padding: 0; margin-left: 0.2rem;
}
.adj-label { font-size: 0.74rem; font-weight: 600; color: var(--text-dim); margin-top: 0.25rem; }
.adj-input, .adj-textarea {
  font: inherit; padding: 0.5rem 0.6rem; border: 1px solid var(--border); border-radius: 8px;
  background: var(--bg, #fff); color: var(--text, inherit); width: 100%; box-sizing: border-box; resize: vertical;
}
.adj-preview { font-size: 0.85rem; padding-top: 0.3rem; }
.adj-over { color: #b91c1c; }
.adj-warn { font-size: 0.78rem; color: #b91c1c; padding-top: 0.35rem; line-height: 1.4; }
.adj-actions { display: flex; justify-content: flex-end; gap: 0.5rem; margin-top: 0.4rem; }
.btn-ghost {
  font: inherit; font-weight: 600; font-size: 0.82rem; padding: 0.45rem 0.9rem;
  border-radius: 8px; border: 1px solid var(--border); background: transparent;
  color: var(--text-dim); cursor: pointer;
}
.btn-ghost:hover:not(:disabled) { color: var(--text); }
.btn-ghost:disabled { opacity: 0.5; cursor: not-allowed; }

@media (max-width: 768px) {
  .totals-grid { grid-template-columns: 1fr; }
  .data-table { font-size: 0.78rem; }
  .data-table th, .data-table td { padding: 0.45rem 0.4rem; }
  .action-cell { white-space: normal; }
}

/* Movement log — quieter than the figures it explains. */
.hist-toggle { display: inline-flex; align-items: center; gap: 0.35rem; background: none; border: 0; padding: 0; font: inherit; color: inherit; cursor: pointer; }
.hist-toggle:hover { color: #2563eb; }
.hist-chev { transition: transform 0.15s; flex: none; }
.hist-chev.open { transform: rotate(90deg); }
.hist-count { font-size: 0.62rem; font-weight: 700; color: #6b7280; background: #f1f3f5; border-radius: 999px; padding: 0 0.35rem; line-height: 1.5; }
.hist-tr > .hist-cell { background: #fafbfc; border-top: 0; padding: 0.6rem 0.9rem 0.85rem; }
.hist-title { font-size: 0.7rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; color: #6b7280; margin-bottom: 0.4rem; }
.hist-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.4rem; }
.hist-row { display: grid; grid-template-columns: minmax(9.5rem, auto) 1fr; gap: 0.1rem 0.6rem; font-size: 0.78rem; line-height: 1.35; }
.hist-when { color: #6b7280; font-variant-numeric: tabular-nums; }
.hist-what { color: #111827; }
.hist-delta { font-weight: 700; font-variant-numeric: tabular-nums; margin-left: 0.3rem; }
.hist-up { color: #047857; }
.hist-down { color: #b91c1c; }
.hist-actor { color: #9ca3af; margin-left: 0.4rem; font-size: 0.72rem; }
/* Column 2 on its own line: the cause reads as a sub-clause of the change. */
.hist-why { grid-column: 2; color: #6b7280; font-size: 0.72rem; }
.hist-empty { font-size: 0.76rem; color: #6b7280; }
</style>
