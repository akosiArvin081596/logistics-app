<template>
  <div class="section earnings-section">
    <div class="section-header">
      <div class="section-title">
        <div class="section-icon" style="background: var(--accent-dim); color: var(--accent);">&#128176;</div>
        Earnings Summary
      </div>
      <div class="month-nav">
        <button class="nav-btn" :disabled="selectedIdx <= 0" @click="selectedIdx--">&#9664;</button>
        <select v-model="selectedIdx" class="month-select">
          <option v-for="(m, i) in months" :key="m.month" :value="i">
            {{ monthLabel(m.month) }}{{ m.isCurrentMonth ? ' (current)' : '' }}
          </option>
        </select>
        <button class="nav-btn" :disabled="selectedIdx >= months.length - 1" @click="selectedIdx++">&#9654;</button>
      </div>
    </div>

    <template v-if="selected">
      <!-- Earnings Card — clickable -->
      <div class="earn-card clickable" :class="selected.investorEarnings >= 0 ? 'positive' : 'negative'" style="margin-bottom:1.25rem;" @click="openDetail('earnings')">
        <div class="earn-label">Your Earnings</div>
        <div class="earn-value">{{ fmt(selected.investorEarnings) }}</div>
        <div class="earn-sub">50% of net profit ({{ fmt(selected.netProfit) }})</div>
        <div class="earn-formula">= (revenue - driverPay - fixedCosts - tripExpenses) / 2</div>
        <div class="click-hint">Click to see full breakdown</div>
      </div>

      <!-- Breakdown Table -->
      <div class="breakdown">
        <div class="breakdown-row clickable" @click="openDetail('revenue')">
          <span class="breakdown-label">Revenue</span>
          <span class="breakdown-value" style="color: var(--accent)">{{ fmt(selected.revenue) }}</span>
          <span class="breakdown-formula">= SUM(Payment col, completed loads)</span>
        </div>
        <div class="breakdown-row deduct clickable" @click="openDetail('driverPay')">
          <span class="breakdown-label">- Driver Pay</span>
          <span class="breakdown-value">{{ fmt(-selected.driverPay) }}</span>
          <span class="breakdown-formula">= $250 x active days this month</span>
        </div>
        <div class="breakdown-row deduct clickable" @click="openDetail('fixedCosts')">
          <span class="breakdown-label">- Fixed Costs</span>
          <span class="breakdown-value">{{ fmt(-selected.fixedCosts) }}</span>
          <span class="breakdown-formula">= insurance + ELD + IRP/12 + HVUT/12 + maint fund</span>
        </div>
        <div class="breakdown-row deduct clickable" @click="openDetail('tripExpenses')">
          <span class="breakdown-label">- Trip Expenses</span>
          <span class="breakdown-value">{{ fmt(-selected.tripExpenses) }}</span>
          <span class="breakdown-formula">= fuel + tolls + repairs (from expenses table)</span>
        </div>
        <div class="breakdown-divider"></div>
        <div class="breakdown-row total clickable" @click="openDetail('netProfit')">
          <span class="breakdown-label">Net Profit</span>
          <span class="breakdown-value" :style="{ color: selected.netProfit >= 0 ? 'var(--accent)' : 'var(--danger)' }">{{ fmt(selected.netProfit) }}</span>
          <span class="breakdown-formula">= revenue - driverPay - fixedCosts - tripExpenses</span>
        </div>
        <div class="breakdown-row split">
          <span class="breakdown-label">&#247; 2 (50/50 split)</span>
          <span class="breakdown-value"></span>
          <span class="breakdown-formula"></span>
        </div>
        <div class="breakdown-row total clickable" @click="openDetail('earnings')">
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
          <div class="alltime-item clickable" @click="openDetail('allRevenue')">
            <span class="alltime-label">Revenue</span>
            <span class="alltime-value">{{ fmt(allTimeRevenue) }}</span>
            <span class="alltime-formula">= SUM(Payment, all completed loads)</span>
          </div>
          <div class="alltime-item clickable" @click="openDetail('allExpenses')">
            <span class="alltime-label">Expenses</span>
            <span class="alltime-value" style="color: var(--danger)">{{ fmt(allTimeExpenses) }}</span>
            <span class="alltime-formula">= driverPay + fixedCosts + tripExp</span>
          </div>
          <div class="alltime-item clickable" @click="openDetail('allNet')">
            <span class="alltime-label">Net</span>
            <span class="alltime-value" :style="{ color: allTimeNet >= 0 ? 'var(--accent)' : 'var(--danger)' }">{{ fmt(allTimeNet) }}</span>
            <span class="alltime-formula">= revenue - expenses</span>
          </div>
          <div class="alltime-item clickable" @click="openDetail('allEarnings')">
            <span class="alltime-label">Your Earnings</span>
            <span class="alltime-value" :style="{ color: allTimeEarnings >= 0 ? 'var(--accent)' : 'var(--danger)' }">{{ fmt(allTimeEarnings) }}</span>
            <span class="alltime-formula">= net / 2 (50/50 split)</span>
          </div>
        </div>
      </div>
    </template>
    <div v-else class="empty">No earnings data yet.</div>

    <!-- Computation Detail Modal -->
    <Dialog :open="!!detailType" @update:open="v => { if (!v) detailType = '' }">
      <DialogContent class="detail-modal">
        <DialogHeader>
          <DialogTitle>{{ modalTitle }}</DialogTitle>
          <DialogDescription>{{ modalSubtitle }}</DialogDescription>
        </DialogHeader>

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
            <div class="modal-hint">Your driver earns $250 for each day they are actively hauling a load.</div>
            <div class="modal-row deduct">
              <span>Fixed Costs</span>
              <span class="val danger">-{{ fmt(selected.fixedCosts) }}</span>
            </div>
            <div class="modal-hint">Monthly insurance, ELD tracking, registration (IRP), road tax (HVUT), and maintenance reserve.</div>
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
              Your driver is compensated at a flat rate of <strong>$250 per active day</strong>. An "active day" is any calendar day where the driver is working on a load &mdash; from the pickup date through the delivery date.
            </div>
            <div class="modal-explain-sm">
              If a driver has overlapping loads (e.g., picked up a new load the same day they delivered the last one), those days are only counted once to avoid double-charging.
            </div>

            <template v-if="Object.keys(driverDetails).length">
              <div class="step-label">Driver Breakdown</div>
              <div v-for="(d, name) in driverDetails" :key="name">
                <div class="modal-row">
                  <span>{{ name }}</span>
                  <span class="val danger">{{ fmt(d.totalPay) }}</span>
                </div>
                <div class="modal-hint">{{ d.activeDays }} active days x ${{ d.dailyRate || 250 }}/day</div>
              </div>
            </template>

            <div class="modal-divider"></div>
            <div class="modal-row bold result">
              <span>Total Driver Pay</span>
              <span class="val danger">{{ fmt(selected.driverPay) }}</span>
            </div>
          </div>
        </template>

        <!-- ======================== -->
        <!-- MONTHLY: Fixed Costs      -->
        <!-- ======================== -->
        <template v-if="detailType === 'fixedCosts' && selected">
          <div class="modal-breakdown">
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
            <div class="modal-row">
              <span>Maintenance Reserve</span>
              <span class="val danger">{{ fmt(fcb.maintReserve) }}</span>
            </div>
            <div class="modal-hint">Monthly reserve set aside for preventive maintenance, tire replacements, and unexpected repairs.</div>

            <div class="modal-divider"></div>
            <div class="modal-row bold result">
              <span>Total Fixed Costs</span>
              <span class="val danger">{{ fmt(selected.fixedCosts) }}</span>
            </div>
            <div class="modal-math">{{ fmt(fcb.insurance) }} + {{ fmt(fcb.eld) }} + {{ fmt(fcb.irp) }} + {{ fmt(fcb.hvut) }} + {{ fmt(fcb.maintReserve) }} = {{ fmt(selected.fixedCosts) }}/mo</div>
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
            <div class="modal-explain-sm">Total compensation paid to your driver(s) at $250/active day.</div>
            <div class="modal-row">
              <span>Driver Pay</span>
              <span class="val danger">{{ fmt(allTimeDriverPay) }}</span>
            </div>

            <div class="step-label">2. Fixed Costs</div>
            <div class="modal-explain-sm">Recurring monthly costs: insurance, ELD, registration (IRP), road tax (HVUT), and maintenance reserve.</div>
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

      </DialogContent>
    </Dialog>
  </div>
</template>

<script setup>
import { ref, computed, watch } from 'vue'
import { formatCurrency as fmt } from '../../utils/format'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '../ui/dialog'

const props = defineProps({
  production: { type: Object, default: () => ({}) },
})

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
const driverDetails = computed(() => props.production?.driverPayDetails || {})

function openDetail(type) {
  detailType.value = type
}

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
const allTimeEarnings = computed(() => Math.round(allTimeNet.value / 2))

const MODAL_CONFIG = {
  earnings:     { title: 'How Your Earnings Are Calculated', subtitle: 'Step-by-step breakdown of your monthly earnings' },
  revenue:      { title: 'Revenue Explained', subtitle: 'Total income from completed loads' },
  driverPay:    { title: 'Driver Pay Explained', subtitle: 'How driver compensation is calculated' },
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

/* Clickable elements */
.clickable { cursor: pointer; transition: all 0.15s ease; position: relative; }
.earn-card.clickable:hover { box-shadow: 0 2px 12px rgba(0,0,0,0.08); transform: translateY(-1px); }
.breakdown-row.clickable { border-radius: 6px; padding-left: 0.5rem; padding-right: 0.5rem; margin: 0 -0.5rem; }
.breakdown-row.clickable:hover { background: var(--accent-dim); }
.alltime-item.clickable { border-radius: 8px; padding: 0.5rem; margin: -0.5rem; }
.alltime-item.clickable:hover { background: var(--accent-dim); }
.click-hint {
  font-size: 0.58rem; color: var(--text-dim); opacity: 0; margin-top: 0.3rem;
  transition: opacity 0.15s ease;
}
.earn-card.clickable:hover .click-hint { opacity: 0.6; }

/* Detail Modal */
.detail-modal { max-width: 520px; }
.modal-breakdown { padding: 0.25rem 0; }
.modal-row {
  display: flex; justify-content: space-between; align-items: center;
  padding: 0.5rem 0.75rem; font-size: 0.85rem;
}
.modal-row .val {
  font-family: 'JetBrains Mono', monospace; font-weight: 600; font-size: 0.88rem;
}
.modal-row .val.accent { color: var(--accent); }
.modal-row .val.danger { color: var(--danger); }
.modal-row.highlight { background: rgba(16, 185, 129, 0.06); border-radius: 6px; }
.modal-row.deduct { color: var(--text-dim); }
.modal-row.bold { font-weight: 700; }
.modal-row.result { background: var(--bg); border-radius: 6px; font-size: 0.92rem; }
.modal-row.split-row { color: var(--text-dim); font-size: 0.78rem; }
.modal-divider { border-top: 1px dashed var(--border); margin: 0.4rem 0.75rem; }

/* Step labels */
.step-label {
  font-size: 0.72rem; font-weight: 700; color: var(--accent);
  text-transform: uppercase; letter-spacing: 0.03em;
  padding: 0.6rem 0.75rem 0.2rem; margin-top: 0.25rem;
}

/* Explanatory text */
.modal-explain {
  font-size: 0.82rem; color: var(--text); padding: 0.25rem 0.75rem 0.5rem;
  line-height: 1.5;
}
.modal-explain-sm {
  font-size: 0.75rem; color: var(--text-dim); padding: 0 0.75rem 0.4rem;
  line-height: 1.4;
}
.modal-hint {
  font-size: 0.68rem; color: var(--text-dim); padding: 0 0.75rem 0.3rem;
  line-height: 1.3; font-style: italic;
}

/* Math formula */
.modal-math {
  font-size: 0.68rem; font-family: 'JetBrains Mono', monospace;
  color: var(--text-dim); opacity: 0.7;
  padding: 0.15rem 0.75rem 0.25rem; text-align: center;
}

/* Callout box */
.modal-callout {
  font-size: 0.75rem; padding: 0.6rem 0.75rem; border-radius: 6px;
  margin: 0.5rem 0.75rem 0; line-height: 1.4;
}
.modal-callout.warning {
  background: rgba(234, 179, 8, 0.08); border: 1px solid rgba(234, 179, 8, 0.25);
  color: var(--text);
}

/* Monthly list */
.modal-monthly-list { max-height: 300px; overflow-y: auto; }
.modal-monthly-list .modal-row { font-size: 0.8rem; padding: 0.35rem 0.75rem; }
.modal-monthly-list .modal-row:nth-child(even) { background: var(--bg); border-radius: 4px; }

@media (max-width: 600px) {
  .alltime-grid { grid-template-columns: repeat(2, 1fr); }
  .breakdown-row { grid-template-columns: 1fr auto; }
  .breakdown-formula { display: none; }
  .detail-modal { max-width: 95vw; }
}
</style>
