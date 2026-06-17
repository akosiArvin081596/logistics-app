<template>
  <div class="section earnings-section">
    <div class="section-header">
      <div class="section-title">
        <div class="section-icon" style="background: var(--accent-dim); color: var(--accent);">&#128176;</div>
        Earnings Summary
      </div>
      <div class="month-nav">
        <button class="nav-btn" :disabled="selectedIdx <= 0" title="Previous month" aria-label="Previous month" @click="selectedIdx--">&#9664;</button>
        <select v-model="selectedIdx" class="month-select" title="Pick a month to view its earnings breakdown">
          <option v-for="(m, i) in months" :key="m.month" :value="i">
            {{ monthLabel(m.month) }}{{ m.isCurrentMonth ? ' (current)' : '' }}
          </option>
        </select>
        <button class="nav-btn" :disabled="selectedIdx >= months.length - 1" title="Next month" aria-label="Next month" @click="selectedIdx++">&#9654;</button>
      </div>
    </div>

    <template v-if="selected">
      <!-- Earnings Card — clickable -->
      <div
        class="earn-card clickable"
        :class="selected.investorEarnings >= 0 ? 'positive' : 'negative'"
        style="margin-bottom:1.25rem;"
        role="button"
        tabindex="0"
        :aria-label="`Open breakdown of your earnings for ${monthLabel(selected.month)}`"
        @click="openDetail('earnings')"
        @keyup.enter="openDetail('earnings')"
        @keyup.space.prevent="openDetail('earnings')"
      >
        <div class="earn-label">Your Earnings</div>
        <div class="earn-value">{{ fmt(selected.investorEarnings) }}</div>
        <div class="earn-sub">50% of net profit ({{ fmt(selected.netProfit) }})</div>
        <div class="earn-formula">= (revenue - driverPay - fixedCosts - tripExpenses) / 2</div>
        <div class="click-hint">Click to see full breakdown</div>
      </div>

      <!-- Breakdown Table -->
      <div class="breakdown">
        <div
          class="breakdown-row clickable"
          role="button" tabindex="0"
          aria-label="Open Revenue breakdown"
          @click="openDetail('revenue')"
          @keyup.enter="openDetail('revenue')"
          @keyup.space.prevent="openDetail('revenue')"
        >
          <span class="breakdown-label">Revenue</span>
          <span class="breakdown-value" style="color: var(--accent)">{{ fmt(selected.revenue) }}</span>
          <span class="breakdown-formula">= SUM(Payment col, completed loads)</span>
        </div>
        <div
          class="breakdown-row deduct clickable"
          role="button" tabindex="0"
          aria-label="Open Driver Pay breakdown"
          @click="openDetail('driverPay')"
          @keyup.enter="openDetail('driverPay')"
          @keyup.space.prevent="openDetail('driverPay')"
        >
          <span class="breakdown-label">- Driver Pay</span>
          <span class="breakdown-value">{{ fmt(-selected.driverPay) }}</span>
          <span class="breakdown-formula">{{ driverPayFormula }}</span>
        </div>
        <div
          class="breakdown-row deduct clickable"
          role="button" tabindex="0"
          aria-label="Open Fixed Costs breakdown"
          @click="openDetail('fixedCosts')"
          @keyup.enter="openDetail('fixedCosts')"
          @keyup.space.prevent="openDetail('fixedCosts')"
        >
          <span class="breakdown-label">- Fixed Costs</span>
          <span class="breakdown-value">{{ fmt(-selected.fixedCosts) }}</span>
          <span class="breakdown-formula" v-if="selected.fixedCostsDeferred">not charged — truck inactive this month</span>
          <span class="breakdown-formula" v-else>= insurance + ELD + IRP/12 + HVUT/12</span>
        </div>
        <div
          class="breakdown-row deduct clickable"
          role="button" tabindex="0"
          aria-label="Open Trip Expenses breakdown"
          @click="openDetail('tripExpenses')"
          @keyup.enter="openDetail('tripExpenses')"
          @keyup.space.prevent="openDetail('tripExpenses')"
        >
          <span class="breakdown-label">- Trip Expenses</span>
          <span class="breakdown-value">{{ fmt(-selected.tripExpenses) }}</span>
          <span class="breakdown-formula">= fuel + tolls + repairs (from expenses table)</span>
        </div>
        <div class="breakdown-divider"></div>
        <div
          class="breakdown-row total clickable"
          role="button" tabindex="0"
          aria-label="Open Net Profit breakdown"
          @click="openDetail('netProfit')"
          @keyup.enter="openDetail('netProfit')"
          @keyup.space.prevent="openDetail('netProfit')"
        >
          <span class="breakdown-label">Net Profit</span>
          <span class="breakdown-value" :style="{ color: selected.netProfit >= 0 ? 'var(--accent)' : 'var(--danger)' }">{{ fmt(selected.netProfit) }}</span>
          <span class="breakdown-formula">= revenue - driverPay - fixedCosts - tripExpenses</span>
        </div>
        <div class="breakdown-row split">
          <span class="breakdown-label">&#247; 2 (50/50 split)</span>
          <span class="breakdown-value"></span>
          <span class="breakdown-formula"></span>
        </div>
        <div
          class="breakdown-row total clickable"
          role="button" tabindex="0"
          aria-label="Open Your Share breakdown"
          @click="openDetail('earnings')"
          @keyup.enter="openDetail('earnings')"
          @keyup.space.prevent="openDetail('earnings')"
        >
          <span class="breakdown-label">Your Share</span>
          <span class="breakdown-value" :style="{ color: selected.investorEarnings >= 0 ? 'var(--accent)' : 'var(--danger)' }">{{ fmt(selected.investorEarnings) }}</span>
          <span class="breakdown-formula">= netProfit / 2</span>
        </div>
      </div>

      <div v-if="selected.isCurrentMonth" class="month-note">* {{ monthLabel(selected.month) }} &mdash; Month in progress</div>

      <!-- All-Time Summary -->
      <div class="alltime">
        <div class="alltime-title">All-Time Totals</div>
        <div class="alltime-grid">
          <div
            class="alltime-item clickable"
            role="button" tabindex="0"
            aria-label="Open all-time Revenue breakdown"
            @click="openDetail('allRevenue')"
            @keyup.enter="openDetail('allRevenue')"
            @keyup.space.prevent="openDetail('allRevenue')"
          >
            <span class="alltime-label">Revenue</span>
            <span class="alltime-value">{{ fmt(allTimeRevenue) }}</span>
            <span class="alltime-formula">= SUM(Payment, all completed loads)</span>
          </div>
          <div
            class="alltime-item clickable"
            role="button" tabindex="0"
            aria-label="Open all-time Expenses breakdown"
            @click="openDetail('allExpenses')"
            @keyup.enter="openDetail('allExpenses')"
            @keyup.space.prevent="openDetail('allExpenses')"
          >
            <span class="alltime-label">Expenses</span>
            <span class="alltime-value" style="color: var(--danger)">{{ fmt(allTimeExpenses) }}</span>
            <span class="alltime-formula">= driverPay + fixedCosts + tripExp</span>
          </div>
          <div
            class="alltime-item clickable"
            role="button" tabindex="0"
            aria-label="Open all-time Net Profit breakdown"
            @click="openDetail('allNet')"
            @keyup.enter="openDetail('allNet')"
            @keyup.space.prevent="openDetail('allNet')"
          >
            <span class="alltime-label">Net</span>
            <span class="alltime-value" :style="{ color: allTimeNet >= 0 ? 'var(--accent)' : 'var(--danger)' }">{{ fmt(allTimeNet) }}</span>
            <span class="alltime-formula">= revenue - expenses</span>
          </div>
          <div
            class="alltime-item clickable"
            role="button" tabindex="0"
            aria-label="Open all-time Your Earnings breakdown"
            @click="openDetail('allEarnings')"
            @keyup.enter="openDetail('allEarnings')"
            @keyup.space.prevent="openDetail('allEarnings')"
          >
            <span class="alltime-label">Your Earnings</span>
            <span class="alltime-value" :style="{ color: allTimeEarnings >= 0 ? 'var(--accent)' : 'var(--danger)' }">{{ fmt(allTimeEarnings) }}</span>
            <span class="alltime-formula">= net / 2 (50/50 split)</span>
          </div>
        </div>
      </div>
    </template>
    <div v-else class="empty">No earnings data yet.</div>

    <!-- Computation Detail Modal -->
    <MetricInfoDialog
      :open="!!detailType"
      :title="modalTitle"
      :subtitle="modalSubtitle"
      @update:open="v => { if (!v) detailType = '' }"
    >
        <!-- ======================== -->
        <!-- MONTHLY: Full P&L        -->
        <!-- ======================== -->
        <template v-if="detailType === 'earnings' && selected">
          <div class="modal-breakdown">
            <div class="modal-explain">
              Here is exactly how your earnings for <strong>{{ monthLabel(selected.month) }}</strong> are calculated, step by step.
            </div>

            <div class="step-label">Step 1: Start with Revenue</div>
            <div class="modal-explain-sm">The total amount your trucks earned from completed loads this month.</div>
            <div class="modal-row highlight">
              <span>Revenue</span>
              <span class="val accent">{{ fmt(selected.revenue) }}</span>
            </div>

            <div class="step-label">Step 2: Subtract Operating Costs</div>
            <div class="modal-explain-sm">These are the costs of running your truck(s) this month.</div>
            <div class="modal-row deduct">
              <span>Driver Pay</span>
              <span class="val danger">-{{ fmt(selected.driverPay) }}</span>
            </div>
            <div class="modal-hint">{{ driverPayFormula }}.</div>
            <div class="modal-row deduct">
              <span>Fixed Costs</span>
              <span class="val danger">-{{ fmt(selected.fixedCosts) }}</span>
            </div>
            <div class="modal-hint" v-if="selected.fixedCostsDeferred">Truck was inactive this month — fixed costs deferred.</div>
            <div class="modal-hint" v-else>Monthly insurance, ELD tracking, registration (IRP), and road tax (HVUT).</div>
            <div class="modal-row deduct">
              <span>Trip Expenses</span>
              <span class="val danger">-{{ fmt(selected.tripExpenses) }}</span>
            </div>
            <div class="modal-hint">Fuel, tolls, repairs, and other costs incurred on the road this month.</div>

            <div class="step-label">Step 3: Calculate Net Profit</div>
            <div class="modal-explain-sm">Revenue minus all costs above = the profit before splitting.</div>
            <div class="modal-divider"></div>
            <div class="modal-row bold">
              <span>Net Profit</span>
              <span class="val" :class="selected.netProfit >= 0 ? 'accent' : 'danger'">{{ fmt(selected.netProfit) }}</span>
            </div>
            <div class="modal-math">{{ fmt(selected.revenue) }} - {{ fmt(selected.driverPay) }} - {{ fmt(selected.fixedCosts) }} - {{ fmt(selected.tripExpenses) }} = {{ fmt(selected.netProfit) }}</div>

            <div class="step-label">Step 4: Apply the 50/50 Split</div>
            <div class="modal-explain-sm">Per your agreement, net profit is split equally between you and LogisX.</div>
            <div class="modal-row split-row">
              <span>&#247; 2 (50/50 split)</span>
              <span></span>
            </div>
            <div class="modal-row bold result">
              <span>Your Earnings</span>
              <span class="val" :class="selected.investorEarnings >= 0 ? 'accent' : 'danger'">{{ fmt(selected.investorEarnings) }}</span>
            </div>
            <div class="modal-math">{{ fmt(selected.netProfit) }} / 2 = {{ fmt(selected.investorEarnings) }}</div>
          </div>
        </template>

        <!-- ======================== -->
        <!-- MONTHLY: Revenue          -->
        <!-- ======================== -->
        <template v-if="detailType === 'revenue' && selected">
          <div class="modal-breakdown">
            <div class="modal-explain">
              This is the total payment earned from all loads your trucks completed in <strong>{{ monthLabel(selected.month) }}</strong>.
            </div>
            <div class="modal-explain-sm">
              Each time one of your trucks delivers a load, the shipper/broker pays a rate for that trip. This figure is the sum of all those payments for the selected month.
            </div>
            <div class="modal-explain-sm">
              <strong>Where it comes from:</strong> The "Payment" column in our Job Tracking system, filtered to loads completed by your assigned driver(s) this month.
            </div>
            <div class="modal-divider"></div>
            <div class="modal-row bold result">
              <span>Monthly Revenue</span>
              <span class="val accent">{{ fmt(selected.revenue) }}</span>
            </div>
          </div>
        </template>

        <!-- ======================== -->
        <!-- MONTHLY: Driver Pay       -->
        <!-- ======================== -->
        <template v-if="detailType === 'driverPay' && selected">
          <div class="modal-breakdown">
            <div class="modal-explain">
              Driver pay counts <strong>unique calendar days worked</strong>, not loads. A day counts when the truck actually traveled (Routemate ELD) while running a completed load. Percentage drivers earn a share of revenue after deductible trip expenses instead.
            </div>

            <template v-if="selected.driverDetails && Object.keys(selected.driverDetails).length">
              <div class="step-label">Driver Breakdown — {{ monthLabel(selected.month) }}</div>
              <div v-for="(d, name) in selected.driverDetails" :key="name" class="driver-block">
                <div class="modal-row">
                  <span>{{ d.displayDriverName || titleCase(name) }}<span v-if="d.payType === 'percentage'" class="modal-tag">{{ d.payPercentage }}%</span></span>
                  <span class="val danger">{{ fmt(d.totalPay) }}</span>
                </div>
                <div class="modal-hint" v-if="d.payType === 'percentage'">
                  {{ d.payPercentage }}% × max(0, {{ fmt(d.monthRevenue || 0) }} revenue − {{ fmt(d.monthDeductible || 0) }} deductibles) = {{ fmt(d.totalPay) }}
                </div>
                <div class="modal-hint" v-else>
                  {{ d.activeDays }} unique calendar day{{ d.activeDays !== 1 ? 's' : '' }} worked × ${{ d.dailyRate || 250 }}/day
                  <span v-if="d.source === 'eld'" class="modal-src eld">ELD-verified</span>
                  <span v-else-if="d.source === 'mixed'" class="modal-src mixed">partly ELD-verified</span>
                  <span v-else class="modal-src est">estimated</span>
                </div>

                <!-- Admin-only: credit a day the ELD missed (truck offline,
                     feed gap). Available even when the driver had 0 days, so
                     a missed day can be added before any breakdown exists. -->
                <div v-if="isSuperAdmin && d.payType !== 'percentage'" class="add-day-row">
                  <button
                    type="button"
                    class="day-action add"
                    :disabled="!!pendingAdd"
                    title="Credit a day the ELD missed (truck offline, lost feed)"
                    @click="askAdd(name, d)"
                  >+ Add day</button>
                </div>
                <div
                  v-if="isSuperAdmin && pendingAdd && pendingAdd.driverKey === name"
                  class="exclude-confirm"
                >
                  <div class="exclude-confirm-sub">
                    Credit a day to <strong>{{ pendingAdd.driverDisplay }}</strong> in {{ monthLabel(selected.month) }} — affects this portal, the company P&amp;L, and any unbilled invoice that includes the date.
                  </div>
                  <input
                    v-model="addDate"
                    type="date"
                    class="exclude-reason"
                    :min="monthBounds.min"
                    :max="monthBounds.max"
                  />
                  <textarea
                    v-model="addReason"
                    class="exclude-reason"
                    rows="2"
                    placeholder="Reason (optional, shown in the audit log — e.g. 'Truck ELD offline')"
                  ></textarea>
                  <div class="exclude-confirm-actions">
                    <button type="button" class="day-action" :disabled="addBusy" @click="cancelAdd">Cancel</button>
                    <button type="button" class="day-action add" :disabled="addBusy || !addDate" @click="submitAdd">
                      {{ addBusy ? 'Adding…' : 'Add day' }}
                    </button>
                  </div>
                </div>

                <details v-if="d.payType !== 'percentage' && d.dayBreakdown && d.dayBreakdown.length" class="day-details" :open="d.dayBreakdown.length <= 7">
                  <summary class="day-summary">Day breakdown ({{ d.dayBreakdown.length }} day{{ d.dayBreakdown.length !== 1 ? 's' : '' }})</summary>
                  <div class="day-list">
                    <template v-for="row in d.dayBreakdown" :key="row.date">
                      <div class="day-row">
                        <span class="day-date">{{ formatDayLabel(row.date) }}</span>
                        <span class="day-loads">{{ row.loadIds.length ? row.loadIds.join(', ') : '(no load id)' }}</span>
                        <button
                          v-if="isSuperAdmin"
                          type="button"
                          class="day-action exclude"
                          :disabled="!!pendingExclude"
                          title="Exclude this day from the driver's pay count"
                          @click="askExclude(name, d, row)"
                        >Exclude</button>
                      </div>
                      <!-- Inline confirm — rendered in-place so it lives inside the
                           dialog's focus scope (a separate teleported modal gets
                           trapped/inert behind the parent dialog). -->
                      <div
                        v-if="isSuperAdmin && pendingExclude && pendingExclude.driverKey === name && pendingExclude.date === row.date"
                        class="exclude-confirm"
                      >
                        <div class="exclude-confirm-sub">
                          Removes <strong>{{ formatDayLabel(row.date) }}</strong> from {{ pendingExclude.driverDisplay }}'s active-day count — affects this portal and the company P&amp;L.
                        </div>
                        <textarea
                          v-model="excludeReason"
                          class="exclude-reason"
                          rows="2"
                          placeholder="Reason (optional, shown in the audit log)"
                        ></textarea>
                        <div class="exclude-confirm-actions">
                          <button type="button" class="day-action" :disabled="excludeBusy" @click="cancelExclude">Cancel</button>
                          <button type="button" class="day-action exclude" :disabled="excludeBusy" @click="submitExclude(excludeReason)">
                            {{ excludeBusy ? 'Excluding…' : 'Exclude day' }}
                          </button>
                        </div>
                      </div>
                    </template>
                  </div>
                </details>

                <div v-if="d.excludedDays && d.excludedDays.length" class="excluded-block">
                  <div class="excluded-heading">Excluded by admin</div>
                  <div v-for="row in d.excludedDays" :key="row.id" class="day-row excluded-row">
                    <span class="day-date">{{ formatDayLabel(row.date) }}</span>
                    <span class="day-reason" :title="row.reason">{{ row.reason || '(no reason given)' }}</span>
                    <button
                      v-if="isSuperAdmin"
                      type="button"
                      class="day-action restore"
                      title="Add this day back to the driver's pay count"
                      :disabled="busyId === row.id"
                      @click="restoreDay(row)"
                    >{{ busyId === row.id ? '...' : 'Restore' }}</button>
                  </div>
                </div>

                <div v-if="d.addedDays && d.addedDays.length" class="excluded-block added-block">
                  <div class="excluded-heading">Added by admin</div>
                  <div v-for="row in d.addedDays" :key="row.id" class="day-row added-row">
                    <span class="day-date">{{ formatDayLabel(row.date) }}</span>
                    <span class="day-reason" :title="row.reason">{{ row.reason || '(no reason given)' }}</span>
                    <button
                      v-if="isSuperAdmin"
                      type="button"
                      class="day-action restore"
                      title="Remove this admin-added day from the pay count"
                      :disabled="busyId === row.id"
                      @click="restoreDay(row)"
                    >{{ busyId === row.id ? '...' : 'Remove' }}</button>
                  </div>
                </div>
              </div>
            </template>
            <div v-else class="modal-explain-sm" style="font-style:italic;">
              No driver activity recorded in {{ monthLabel(selected.month) }}.
            </div>

            <div class="modal-divider"></div>
            <div class="modal-row bold result">
              <span>Total Driver Pay ({{ monthLabel(selected.month) }})</span>
              <span class="val danger">{{ fmt(selected.driverPay) }}</span>
            </div>
          </div>
        </template>

        <!-- ======================== -->
        <!-- MONTHLY: Fixed Costs      -->
        <!-- ======================== -->
        <template v-if="detailType === 'fixedCosts' && selected">
          <div class="modal-breakdown">
            <template v-if="selected.fixedCostsDeferred">
              <div class="modal-explain">
                Your {{ fcb.truckCount > 1 ? 'trucks were' : 'truck was' }} inactive in {{ monthLabel(selected.month) }} — no loads, no driver activity, no trip expenses. We deferred the fixed costs for this month so an idle month doesn't appear as a loss.
              </div>
              <div class="modal-explain-sm">
                Once your truck is dispatched even one load in a month, the full monthly fixed costs apply normally.
              </div>
              <div class="modal-divider"></div>
              <div class="modal-row bold result">
                <span>Total Fixed Costs ({{ monthLabel(selected.month) }})</span>
                <span class="val">{{ fmt(0) }}</span>
              </div>
            </template>
            <template v-else>
              <div class="modal-explain">
                These are the recurring monthly costs to keep your {{ fcb.truckCount > 1 ? fcb.truckCount + ' trucks' : 'truck' }} legally compliant and road-ready. They are charged every month regardless of how many loads are completed.
              </div>

              <div class="step-label">Cost Breakdown (Monthly Total)</div>
              <div class="modal-row">
                <span>Insurance</span>
                <span class="val danger">{{ fmt(fcb.insurance) }}</span>
              </div>
              <div class="modal-hint">Commercial liability insurance required to operate.</div>
              <div class="modal-row">
                <span>ELD Device</span>
                <span class="val danger">{{ fmt(fcb.eld) }}</span>
              </div>
              <div class="modal-hint">Electronic Logging Device &mdash; federally required to track driver hours.</div>
              <div class="modal-row">
                <span>IRP Registration</span>
                <span class="val danger">{{ fmt(fcb.irp) }}</span>
              </div>
              <div class="modal-hint">International Registration Plan &mdash; annual fee divided by 12 months.</div>
              <div class="modal-row">
                <span>HVUT Road Tax</span>
                <span class="val danger">{{ fmt(fcb.hvut) }}</span>
              </div>
              <div class="modal-hint">Heavy Vehicle Use Tax (Form 2290) &mdash; annual fee divided by 12 months.</div>

              <div class="modal-divider"></div>
              <div class="modal-row bold result">
                <span>Total Fixed Costs</span>
                <span class="val danger">{{ fmt(selected.fixedCosts) }}</span>
              </div>
              <div class="modal-math">{{ fmt(fcb.insurance) }} + {{ fmt(fcb.eld) }} + {{ fmt(fcb.irp) }} + {{ fmt(fcb.hvut) }} = {{ fmt(selected.fixedCosts) }}/mo</div>
            </template>
          </div>
        </template>

        <!-- ======================== -->
        <!-- MONTHLY: Trip Expenses    -->
        <!-- ======================== -->
        <template v-if="detailType === 'tripExpenses' && selected">
          <div class="modal-breakdown">
            <div class="modal-explain">
              These are variable costs that only occur when your truck is on the road. Unlike fixed costs, trip expenses change from month to month based on how many loads were hauled and the routes taken.
            </div>

            <template v-if="Object.keys(selected.tripExpCategories || {}).length">
              <div class="step-label">Expense Categories</div>
              <div v-for="(amt, cat) in selected.tripExpCategories" :key="cat">
                <div class="modal-row">
                  <span>{{ catLabel(cat) }}</span>
                  <span class="val danger">{{ fmt(amt) }}</span>
                </div>
              </div>
            </template>
            <div v-else class="modal-explain-sm" style="font-style:italic;">
              No trip expenses were logged for this month.
            </div>

            <div class="modal-divider"></div>
            <div class="modal-row bold result">
              <span>Total Trip Expenses</span>
              <span class="val danger">{{ fmt(selected.tripExpenses) }}</span>
            </div>
            <div class="modal-explain-sm" style="margin-top:0.5rem;">
              <strong>Where it comes from:</strong> Receipts and expense reports submitted by your driver and logged in the system.
            </div>
          </div>
        </template>

        <!-- ======================== -->
        <!-- MONTHLY: Net Profit       -->
        <!-- ======================== -->
        <template v-if="detailType === 'netProfit' && selected">
          <div class="modal-breakdown">
            <div class="modal-explain">
              Net profit is what remains after all operating costs are subtracted from your truck's revenue. This is the number that gets split 50/50 between you and LogisX.
            </div>

            <div class="step-label">The Calculation</div>
            <div class="modal-row highlight">
              <span>Revenue (loads completed)</span>
              <span class="val accent">{{ fmt(selected.revenue) }}</span>
            </div>
            <div class="modal-row deduct">
              <span>- Driver Pay</span>
              <span class="val danger">-{{ fmt(selected.driverPay) }}</span>
            </div>
            <div class="modal-row deduct">
              <span>- Fixed Costs</span>
              <span class="val danger">-{{ fmt(selected.fixedCosts) }}</span>
            </div>
            <div class="modal-row deduct">
              <span>- Trip Expenses</span>
              <span class="val danger">-{{ fmt(selected.tripExpenses) }}</span>
            </div>
            <div class="modal-divider"></div>
            <div class="modal-row bold result">
              <span>Net Profit</span>
              <span class="val" :class="selected.netProfit >= 0 ? 'accent' : 'danger'">{{ fmt(selected.netProfit) }}</span>
            </div>
            <div class="modal-math">{{ fmt(selected.revenue) }} - {{ fmt(selected.driverPay) }} - {{ fmt(selected.fixedCosts) }} - {{ fmt(selected.tripExpenses) }} = {{ fmt(selected.netProfit) }}</div>

            <div v-if="selected.netProfit < 0" class="modal-callout warning">
              A negative net profit means operating costs exceeded revenue this month. This can happen during the first month, slow freight periods, or when major maintenance occurs.
            </div>
          </div>
        </template>

        <!-- ======================== -->
        <!-- ALL-TIME: Revenue         -->
        <!-- ======================== -->
        <template v-if="detailType === 'allRevenue'">
          <div class="modal-breakdown">
            <div class="modal-explain">
              This is the total revenue your fleet has generated since your first load. It represents every dollar earned from completed deliveries across all months.
            </div>

            <div class="step-label">Monthly Revenue History</div>
            <div class="modal-monthly-list" v-if="months.length">
              <div class="modal-row" v-for="m in months" :key="m.month">
                <span>{{ monthLabel(m.month) }}{{ m.isCurrentMonth ? ' *' : '' }}</span>
                <span class="val accent">{{ fmt(m.revenue) }}</span>
              </div>
            </div>
            <div class="modal-divider"></div>
            <div class="modal-row bold result">
              <span>All-Time Revenue</span>
              <span class="val accent">{{ fmt(allTimeRevenue) }}</span>
            </div>
          </div>
        </template>

        <!-- ======================== -->
        <!-- ALL-TIME: Expenses        -->
        <!-- ======================== -->
        <template v-if="detailType === 'allExpenses'">
          <div class="modal-breakdown">
            <div class="modal-explain">
              This is the total cost of operating your fleet since day one. Expenses fall into three categories:
            </div>

            <div class="step-label">1. Driver Pay</div>
            <div class="modal-explain-sm">Total compensation paid to your driver(s) — fixed-rate drivers earn per active day, percentage drivers earn a share of revenue after deductible trip expenses.</div>
            <div class="modal-row">
              <span>Driver Pay</span>
              <span class="val danger">{{ fmt(allTimeDriverPay) }}</span>
            </div>

            <div class="step-label">2. Fixed Costs</div>
            <div class="modal-explain-sm">Recurring monthly costs: insurance, ELD, registration (IRP), and road tax (HVUT).</div>
            <div class="modal-row">
              <span>Fixed Costs</span>
              <span class="val danger">{{ fmt(allTimeFixedCosts) }}</span>
            </div>

            <div class="step-label">3. Trip Expenses</div>
            <div class="modal-explain-sm">Variable costs from actual trips: fuel, tolls, repairs, and other on-the-road expenses.</div>
            <div class="modal-row">
              <span>Trip Expenses</span>
              <span class="val danger">{{ fmt(allTimeTripExpenses) }}</span>
            </div>

            <div class="modal-divider"></div>
            <div class="modal-row bold result">
              <span>Total Expenses</span>
              <span class="val danger">{{ fmt(allTimeDriverPay + allTimeFixedCosts + allTimeTripExpenses) }}</span>
            </div>
            <div class="modal-math">{{ fmt(allTimeDriverPay) }} + {{ fmt(allTimeFixedCosts) }} + {{ fmt(allTimeTripExpenses) }} = {{ fmt(allTimeDriverPay + allTimeFixedCosts + allTimeTripExpenses) }}</div>
          </div>
        </template>

        <!-- ======================== -->
        <!-- ALL-TIME: Net             -->
        <!-- ======================== -->
        <template v-if="detailType === 'allNet'">
          <div class="modal-breakdown">
            <div class="modal-explain">
              This is the total profit your fleet has generated after all operating costs. It represents the bottom line across your entire investment period.
            </div>

            <div class="step-label">The Calculation</div>
            <div class="modal-row highlight">
              <span>All-Time Revenue</span>
              <span class="val accent">{{ fmt(allTimeRevenue) }}</span>
            </div>
            <div class="modal-explain-sm">Every dollar earned from completed loads.</div>
            <div class="modal-row deduct">
              <span>- All-Time Expenses</span>
              <span class="val danger">-{{ fmt(allTimeExpenses) }}</span>
            </div>
            <div class="modal-explain-sm">Driver pay + fixed costs + trip expenses combined.</div>
            <div class="modal-divider"></div>
            <div class="modal-row bold result">
              <span>Net Profit</span>
              <span class="val" :class="allTimeNet >= 0 ? 'accent' : 'danger'">{{ fmt(allTimeNet) }}</span>
            </div>
            <div class="modal-math">{{ fmt(allTimeRevenue) }} - {{ fmt(allTimeExpenses) }} = {{ fmt(allTimeNet) }}</div>
          </div>
        </template>

        <!-- ======================== -->
        <!-- ALL-TIME: Your Earnings   -->
        <!-- ======================== -->
        <template v-if="detailType === 'allEarnings'">
          <div class="modal-breakdown">
            <div class="modal-explain">
              This is your cumulative 50% share of all profits since your first load. Per your agreement with LogisX, net profit is split equally &mdash; half goes to you, half goes to the company.
            </div>

            <div class="step-label">The Calculation</div>
            <div class="modal-row highlight">
              <span>All-Time Net Profit</span>
              <span class="val" :class="allTimeNet >= 0 ? 'accent' : 'danger'">{{ fmt(allTimeNet) }}</span>
            </div>
            <div class="modal-explain-sm">Revenue ({{ fmt(allTimeRevenue) }}) minus all expenses ({{ fmt(allTimeExpenses) }}).</div>
            <div class="modal-row split-row">
              <span>&#247; 2 (your 50% share)</span>
              <span></span>
            </div>
            <div class="modal-divider"></div>
            <div class="modal-row bold result">
              <span>Your All-Time Earnings</span>
              <span class="val" :class="allTimeEarnings >= 0 ? 'accent' : 'danger'">{{ fmt(allTimeEarnings) }}</span>
            </div>
            <div class="modal-math">{{ fmt(allTimeNet) }} / 2 = {{ fmt(allTimeEarnings) }}</div>

            <div class="step-label" style="margin-top:1rem;">Month-by-Month History</div>
            <div class="modal-monthly-list" v-if="months.length">
              <div class="modal-row" v-for="m in months" :key="m.month">
                <span>{{ monthLabel(m.month) }}{{ m.isCurrentMonth ? ' *' : '' }}</span>
                <span class="val" :class="m.investorEarnings >= 0 ? 'accent' : 'danger'">{{ fmt(m.investorEarnings) }}</span>
              </div>
            </div>
          </div>
        </template>

    </MetricInfoDialog>
  </div>
</template>

<script setup>
import { ref, computed, watch } from 'vue'
import { formatCurrency as fmt } from '../../utils/format'
import MetricInfoDialog from './MetricInfoDialog.vue'
import { useApi } from '../../composables/useApi'
import { useToast } from '../../composables/useToast'

const props = defineProps({
  production: { type: Object, default: () => ({}) },
  isSuperAdmin: { type: Boolean, default: false },
})
const emit = defineEmits(['changed'])

const api = useApi()
const { show: toast } = useToast()

const months = computed(() => props.production?.monthlyEarnings || [])
const selectedIdx = ref(0)

// Default to current month (last item) when data loads; clamp if months shrinks
watch(months, (v) => {
  if (v.length) selectedIdx.value = Math.min(selectedIdx.value, v.length - 1) || v.length - 1
  else selectedIdx.value = 0
}, { immediate: true })

const selected = computed(() => months.value[selectedIdx.value] || null)

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
function monthLabel(mk) {
  if (!mk) return ''
  const [y, m] = mk.split('-')
  return `${MONTH_NAMES[parseInt(m) - 1] || m} ${y}`
}

// --- Detail modal ---
const detailType = ref('')
const fcb = computed(() => props.production?.fixedCostBreakdown || { insurance: 0, eld: 0, irp: 0, hvut: 0, maintReserve: 0, truckCount: 1 })

function openDetail(type) {
  detailType.value = type
  // Drop any half-started exclude when (re)opening a modal section.
  pendingExclude.value = null
  excludeReason.value = ''
}

// Clear a pending exclude if the user navigates to another month mid-flow.
watch(selectedIdx, () => {
  pendingExclude.value = null
  excludeReason.value = ''
})

// Expense category label (backend stores lowercase type strings)
const CAT_LABELS = { fuel: 'Fuel', maintenance: 'Maintenance / Repairs', tolls: 'Tolls', parking: 'Parking', other: 'Other', repair: 'Repairs', tires: 'Tires', def: 'DEF Fluid' }
function catLabel(cat) {
  return CAT_LABELS[cat] || (cat ? cat.charAt(0).toUpperCase() + cat.slice(1) : 'Other')
}

// All-time totals derived from monthly data (ensures consistency: all-time = SUM of months)
const allTimeRevenue = computed(() => months.value.reduce((s, m) => s + (m.revenue || 0), 0))
const allTimeDriverPay = computed(() => months.value.reduce((s, m) => s + (m.driverPay || 0), 0))
const allTimeFixedCosts = computed(() => months.value.reduce((s, m) => s + (m.fixedCosts || 0), 0))
const allTimeTripExpenses = computed(() => months.value.reduce((s, m) => s + (m.tripExpenses || 0), 0))
const allTimeExpenses = computed(() => allTimeDriverPay.value + allTimeFixedCosts.value + allTimeTripExpenses.value)
const allTimeNet = computed(() => allTimeRevenue.value - allTimeExpenses.value)
// Investor's share of net profit, driven by the configured split (server returns
// investorSplitPct on the production payload). Defaults to 50 when absent.
const investorSplitPct = computed(() => props.production?.investorSplitPct ?? 50)
const allTimeEarnings = computed(() => Math.round(allTimeNet.value * (investorSplitPct.value / 100)))

// Render the right formula label for the selected month's Driver Pay row.
// Server returns payType / payPercentage per driver in driverDetails — branch
// on those so percentage drivers (e.g. Rodney @ 30%) don't get mislabeled as
// "$250 × active days".
const driverPayFormula = computed(() => {
  const details = selected.value && selected.value.driverDetails
  if (!details || !Object.keys(details).length) return '= $250 × calendar days worked this month'
  const drivers = Object.values(details)
  const allFixed = drivers.every(d => d.payType !== 'percentage')
  const allPct = drivers.every(d => d.payType === 'percentage')
  if (allFixed) {
    const rates = [...new Set(drivers.map(d => d.dailyRate || 250))]
    const rateStr = rates.length === 1 ? `$${rates[0]}` : '$rate'
    return `= ${rateStr} × calendar days worked this month`
  }
  if (allPct) {
    const pcts = [...new Set(drivers.map(d => d.payPercentage || 0))]
    const pctStr = pcts.length === 1 ? `${pcts[0]}%` : 'driver %'
    return `= ${pctStr} × (revenue − deductible trip expenses)`
  }
  return '= per-driver pay structure (see detail)'
})

function titleCase(s) {
  return (s || '').replace(/\b\w/g, c => c.toUpperCase())
}

// Render "Fri, May 15" from "2026-05-15". Parses as local time so the day
// label matches what the user typed into the sheet, regardless of timezone.
function formatDayLabel(ymd) {
  if (!ymd) return ''
  const [y, m, d] = ymd.split('-').map(Number)
  if (!y || !m || !d) return ymd
  const dt = new Date(y, m - 1, d)
  return dt.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
}

// Exclude/restore state — single-flight; the modal is small enough that we
// don't need a per-driver busy map.
const pendingExclude = ref(null) // { driverKey, driverDisplay, date }
const excludeReason = ref('')
const excludeBusy = ref(false)
const busyId = ref(0)

// Add-day state (mirror of exclude). `addDate` defaults to today clipped to
// the currently-selected month; the date input enforces min/max via monthBounds.
const pendingAdd = ref(null) // { driverKey, driverDisplay }
const addDate = ref('')
const addReason = ref('')
const addBusy = ref(false)

const monthBounds = computed(() => {
  const mk = selected.value && selected.value.month
  if (!mk || !/^\d{4}-\d{2}$/.test(mk)) return { min: '', max: '' }
  const [y, m] = mk.split('-').map(Number)
  const last = new Date(y, m, 0).getDate() // day 0 of next month = last day of this
  const pad = (n) => String(n).padStart(2, '0')
  return { min: `${mk}-01`, max: `${mk}-${pad(last)}` }
})

function askExclude(driverKey, driverDetail, row) {
  excludeReason.value = ''
  pendingExclude.value = {
    driverKey,
    driverDisplay: driverDetail.displayDriverName || titleCase(driverKey),
    date: row.date,
  }
}

function cancelExclude() {
  if (excludeBusy.value) return
  pendingExclude.value = null
  excludeReason.value = ''
}

async function submitExclude(reason) {
  const target = pendingExclude.value
  if (!target || excludeBusy.value) return
  excludeBusy.value = true
  try {
    await api.post('/api/admin/excluded-days', {
      driverName: target.driverKey,
      date: target.date,
      reason: reason || '',
    })
    toast(`Excluded ${formatDayLabel(target.date)}`)
    pendingExclude.value = null
    excludeReason.value = ''
    emit('changed')
  } catch (err) {
    toast(err?.message || 'Failed to exclude day', 'error')
  } finally {
    excludeBusy.value = false
  }
}

async function restoreDay(row) {
  if (busyId.value) return
  busyId.value = row.id
  try {
    await api.del(`/api/admin/excluded-days/${row.id}`)
    toast(`Restored ${formatDayLabel(row.date)}`)
    emit('changed')
  } catch (err) {
    toast(err?.message || 'Failed to restore day', 'error')
  } finally {
    busyId.value = 0
  }
}

function askAdd(driverKey, driverDetail) {
  // Default to today if it's in the selected month, otherwise to the 1st.
  const today = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  const todayStr = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`
  const inMonth = todayStr >= monthBounds.value.min && todayStr <= monthBounds.value.max
  addDate.value = inMonth ? todayStr : monthBounds.value.min
  addReason.value = ''
  pendingAdd.value = {
    driverKey,
    driverDisplay: driverDetail.displayDriverName || titleCase(driverKey),
  }
}

function cancelAdd() {
  if (addBusy.value) return
  pendingAdd.value = null
  addDate.value = ''
  addReason.value = ''
}

async function submitAdd() {
  const target = pendingAdd.value
  if (!target || addBusy.value || !addDate.value) return
  // Guardrail: date input min/max only enforces in browsers that support it.
  if (addDate.value < monthBounds.value.min || addDate.value > monthBounds.value.max) {
    toast(`Date must be within ${monthLabel(selected.value.month)}`, 'error')
    return
  }
  addBusy.value = true
  try {
    await api.post('/api/admin/excluded-days', {
      driverName: target.driverKey,
      date: addDate.value,
      reason: addReason.value || '',
      action: 'add',
    })
    toast(`Added ${formatDayLabel(addDate.value)} for ${target.driverDisplay}`)
    pendingAdd.value = null
    addDate.value = ''
    addReason.value = ''
    emit('changed')
  } catch (err) {
    toast(err?.message || 'Failed to add day', 'error')
  } finally {
    addBusy.value = false
  }
}

const MODAL_CONFIG = {
  earnings:     { title: 'How Your Earnings Are Calculated', subtitle: 'Step-by-step breakdown of your monthly earnings' },
  revenue:      { title: 'Revenue Explained', subtitle: 'Total income from completed loads' },
  driverPay:    { title: 'Driver Pay Explained', subtitle: 'Per calendar day worked (ELD-matched), not per load' },
  fixedCosts:   { title: 'Fixed Costs Explained', subtitle: 'Monthly costs to keep your truck(s) running' },
  tripExpenses: { title: 'Trip Expenses Explained', subtitle: 'Variable costs from hauling loads' },
  netProfit:    { title: 'Net Profit Explained', subtitle: 'Revenue minus all operating costs' },
  allRevenue:   { title: 'All-Time Revenue', subtitle: 'Cumulative income since your first load' },
  allExpenses:  { title: 'All-Time Expenses', subtitle: 'Total operating costs across all months' },
  allNet:       { title: 'All-Time Net Profit', subtitle: 'Your fleet\'s total profit to date' },
  allEarnings:  { title: 'All-Time Your Earnings', subtitle: 'Your cumulative 50% share of profits' },
}

const modalTitle = computed(() => {
  const cfg = MODAL_CONFIG[detailType.value]
  if (!cfg) return ''
  const isMonthly = !detailType.value.startsWith('all') && selected.value
  return isMonthly ? `${cfg.title}` : cfg.title
})
const modalSubtitle = computed(() => {
  const cfg = MODAL_CONFIG[detailType.value]
  if (!cfg) return ''
  const isMonthly = !detailType.value.startsWith('all') && selected.value
  return isMonthly ? `${monthLabel(selected.value.month)} — ${cfg.subtitle}` : cfg.subtitle
})
</script>

<style scoped>
.earnings-section {
  background: var(--surface);
  border: 2px solid var(--accent);
  border-radius: var(--radius);
  padding: 1.25rem;
  margin-bottom: 1.25rem;
}
.section-header {
  display: flex; justify-content: space-between; align-items: center;
  margin-bottom: 1rem; flex-wrap: wrap; gap: 0.75rem;
}
.section-title {
  font-size: 0.95rem; font-weight: 700;
  display: flex; align-items: center; gap: 0.5rem;
}
.section-icon {
  width: 28px; height: 28px; border-radius: 8px;
  display: flex; align-items: center; justify-content: center; font-size: 0.9rem;
}
.month-nav {
  display: flex; align-items: center; gap: 0.4rem;
}
.nav-btn {
  width: 28px; height: 28px; border-radius: 6px;
  border: 1px solid var(--border); background: var(--bg);
  cursor: pointer; font-size: 0.7rem; color: var(--text);
  display: flex; align-items: center; justify-content: center;
}
.nav-btn:disabled { opacity: 0.3; cursor: default; }
.nav-btn:hover:not(:disabled) { background: var(--accent-dim); border-color: var(--accent); }
.month-select {
  padding: 0.35rem 0.6rem; border-radius: 6px;
  border: 1px solid var(--border); background: var(--bg);
  font-family: inherit; font-size: 0.78rem; font-weight: 600;
  color: var(--text); cursor: pointer;
}
.month-select:focus { outline: none; border-color: var(--accent); }

/* Earnings Card */
.earn-card {
  padding: 1.25rem; border-radius: var(--radius); text-align: center;
  border: 1px solid var(--border);
}
.earn-card.positive { border-color: var(--accent); background: rgba(16, 185, 129, 0.04); }
.earn-card.negative { border-color: var(--danger); background: rgba(239, 68, 68, 0.04); }
.earn-label {
  font-size: 0.72rem; font-weight: 600; color: var(--text-dim);
  text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 0.4rem;
}
.earn-value {
  font-family: 'JetBrains Mono', monospace; font-size: 1.8rem; font-weight: 700;
}
.earn-card.positive .earn-value { color: var(--accent); }
.earn-card.negative .earn-value { color: var(--danger); }
.earn-sub { font-size: 0.72rem; color: var(--text-dim); margin-top: 0.2rem; }
.earn-formula {
  font-size: 0.58rem; font-family: 'JetBrains Mono', monospace;
  color: var(--text-dim); opacity: 0.5; font-style: italic; margin-top: 0.15rem;
}

/* Breakdown Table */
.breakdown {
  background: var(--bg); border-radius: 8px; padding: 0.75rem 1rem; margin-bottom: 1rem;
}
.breakdown-row {
  display: grid; grid-template-columns: 1fr auto 1fr; gap: 0.5rem;
  padding: 0.4rem 0; align-items: center;
}
.breakdown-label { font-size: 0.82rem; font-weight: 500; }
.breakdown-value {
  font-family: 'JetBrains Mono', monospace; font-size: 0.85rem; font-weight: 600;
  text-align: right;
}
.breakdown-formula {
  font-size: 0.55rem; font-family: 'JetBrains Mono', monospace;
  color: var(--text-dim); opacity: 0.5; font-style: italic; text-align: right;
}
.breakdown-row.deduct .breakdown-label { color: var(--text-dim); }
.breakdown-row.deduct .breakdown-value { color: var(--danger); }
.breakdown-row.total { font-weight: 700; }
.breakdown-row.total .breakdown-label { font-weight: 700; }
.breakdown-row.split .breakdown-label { color: var(--text-dim); font-size: 0.75rem; }
.breakdown-divider {
  border-top: 1px dashed var(--border); margin: 0.3rem 0;
}

.month-note {
  font-size: 0.72rem; color: var(--text-dim); font-style: italic; margin-bottom: 1rem;
}

/* All-Time Summary */
.alltime {
  background: var(--bg); border-radius: 8px; padding: 0.75rem 1rem;
}
.alltime-title {
  font-size: 0.68rem; font-weight: 600; color: var(--text-dim);
  text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 0.5rem;
}
.alltime-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 0.75rem; }
.alltime-item { text-align: center; }
.alltime-label { font-size: 0.65rem; color: var(--text-dim); display: block; }
.alltime-value {
  font-family: 'JetBrains Mono', monospace; font-size: 0.95rem; font-weight: 700;
  display: block; margin-top: 0.15rem;
}
.alltime-formula {
  font-size: 0.55rem; font-family: 'JetBrains Mono', monospace;
  color: var(--text-dim); opacity: 0.5; font-style: italic;
  display: block; margin-top: 0.1rem;
}

.empty { text-align: center; color: var(--text-dim); padding: 2rem; font-size: 0.85rem; }

/* Section-specific clickable affordances. Generic .clickable, .click-hint,
   and all .modal-* / .step-label / .modal-explain styles live in
   client/src/assets/shared.css. */
.earn-card.clickable { cursor: pointer; transition: all 0.15s ease; position: relative; }
.earn-card.clickable:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.earn-card.clickable:hover { box-shadow: 0 2px 12px rgba(0,0,0,0.08); transform: translateY(-1px); }
.breakdown-row.clickable { cursor: pointer; transition: all 0.15s ease; border-radius: 6px; padding-left: 0.5rem; padding-right: 0.5rem; margin: 0 -0.5rem; }
.breakdown-row.clickable:hover { background: var(--accent-dim); }
.breakdown-row.clickable:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.alltime-item.clickable { cursor: pointer; transition: all 0.15s ease; border-radius: 8px; padding: 0.5rem; margin: -0.5rem; }
.alltime-item.clickable:hover { background: var(--accent-dim); }
.alltime-item.clickable:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

/* EarningsSection-only modal badges (general modal styles live in shared.css). */
.modal-tag {
  display: inline-block; margin-left: 0.4rem; padding: 0 0.4rem;
  font-size: 0.65rem; font-weight: 600; color: var(--accent);
  background: var(--accent-dim); border-radius: 999px; vertical-align: middle;
}
/* Driver-pay source badge: ELD-verified vs estimated active days */
.modal-src {
  display: inline-block; margin-left: 0.4rem; padding: 0 0.4rem;
  font-size: 0.6rem; font-weight: 700; border-radius: 999px;
  vertical-align: middle; font-style: normal; letter-spacing: 0.02em;
}
.modal-src.eld { color: #16a34a; background: rgba(22, 163, 74, 0.12); }
.modal-src.mixed { color: #ca8a04; background: rgba(202, 138, 4, 0.12); }
.modal-src.est { color: var(--text-dim); background: var(--accent-dim); }

/* Day-by-day breakdown (Driver Pay modal) */
.driver-block { padding-bottom: 0.4rem; }
.driver-block + .driver-block { border-top: 1px dashed var(--border); padding-top: 0.4rem; }
.day-details {
  margin: 0.25rem 0.75rem 0.6rem;
  background: var(--bg); border-radius: 6px;
  font-size: 0.78rem;
}
.day-summary {
  cursor: pointer; user-select: none;
  padding: 0.45rem 0.6rem;
  font-size: 0.72rem; font-weight: 600; color: var(--text-dim);
  list-style: none;
}
.day-summary::-webkit-details-marker { display: none; }
.day-summary::before {
  content: '▸'; display: inline-block; margin-right: 0.4rem;
  transition: transform 0.15s;
}
.day-details[open] .day-summary::before { transform: rotate(90deg); }
.day-list {
  padding: 0 0.2rem 0.4rem;
  display: flex; flex-direction: column; gap: 0.1rem;
}
.day-row {
  display: grid;
  grid-template-columns: 7.5rem 1fr auto;
  align-items: center; gap: 0.5rem;
  padding: 0.3rem 0.6rem; border-radius: 4px;
  font-size: 0.78rem;
}
.day-row:hover { background: var(--surface); }
.day-date {
  font-family: 'JetBrains Mono', monospace; font-size: 0.74rem;
  color: var(--text);
}
.day-loads {
  font-family: 'JetBrains Mono', monospace; font-size: 0.7rem;
  color: var(--text-dim);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.day-reason {
  font-size: 0.74rem; color: var(--text-dim); font-style: italic;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.day-action {
  font-family: inherit; font-size: 0.68rem; font-weight: 600;
  border: 1px solid var(--border); border-radius: 4px;
  background: transparent; color: var(--text-dim);
  padding: 0.15rem 0.5rem; cursor: pointer;
  transition: all 0.12s;
}
.day-action:hover:not(:disabled) {
  border-color: var(--accent); color: var(--accent);
}
.day-action.exclude:hover:not(:disabled) {
  border-color: var(--danger); color: var(--danger);
}
.day-action.add {
  border-color: rgba(34, 197, 94, 0.4); color: rgb(22, 163, 74);
}
.day-action.add:hover:not(:disabled) {
  border-color: rgb(22, 163, 74); color: rgb(22, 163, 74);
  background: rgba(34, 197, 94, 0.08);
}
.day-action:disabled { opacity: 0.4; cursor: default; }
.add-day-row {
  margin: 0.35rem 0.75rem 0;
  display: flex; justify-content: flex-end;
}
.excluded-block {
  margin: 0 0.75rem 0.6rem;
  background: rgba(234, 179, 8, 0.06);
  border: 1px dashed rgba(234, 179, 8, 0.3);
  border-radius: 6px; padding: 0.35rem 0.4rem;
}
.excluded-heading {
  font-size: 0.65rem; font-weight: 700; color: rgba(180, 130, 0, 0.9);
  text-transform: uppercase; letter-spacing: 0.04em;
  padding: 0.25rem 0.4rem;
}
.day-row.excluded-row .day-date { text-decoration: line-through; opacity: 0.7; }
.added-block {
  background: rgba(34, 197, 94, 0.06);
  border-color: rgba(34, 197, 94, 0.3);
}
.added-block .excluded-heading { color: rgb(22, 163, 74); }
.day-row.added-row .day-date { font-weight: 700; color: rgb(22, 163, 74); }

/* Inline exclude confirmation (lives inside the dialog, no nested modal) */
.exclude-confirm {
  margin: 0.1rem 0.4rem 0.4rem;
  padding: 0.6rem;
  background: rgba(239, 68, 68, 0.05);
  border: 1px solid rgba(239, 68, 68, 0.25);
  border-radius: 6px;
}
.exclude-confirm-sub {
  font-size: 0.74rem; color: var(--text-dim); line-height: 1.4;
  margin-bottom: 0.5rem;
}
.exclude-reason {
  width: 100%; box-sizing: border-box;
  font-family: inherit; font-size: 0.8rem;
  padding: 0.45rem 0.55rem;
  border: 1px solid var(--border); border-radius: 6px;
  background: var(--bg); color: var(--text);
  resize: vertical; min-height: 48px;
}
.exclude-reason:focus { outline: none; border-color: var(--accent); }
.exclude-confirm-actions {
  display: flex; justify-content: flex-end; gap: 0.5rem;
  margin-top: 0.5rem;
}

@media (max-width: 600px) {
  .alltime-grid { grid-template-columns: repeat(2, 1fr); }
  .breakdown-row { grid-template-columns: 1fr auto; }
  .breakdown-formula { display: none; }
}
</style>
