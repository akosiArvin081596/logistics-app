<template>
  <div class="section">
    <div class="section-title">
      <div class="section-icon" style="background: var(--blue-dim); color: var(--blue);">&#9679;</div>
      Asset Security Dashboard
    </div>

    <div class="asset-grid">
      <div
        class="asset-item clickable"
        role="button" tabindex="0"
        aria-label="Open Total Miles breakdown"
        title="Click for breakdown"
        @click="openDetail('totalMiles')"
        @keyup.enter="openDetail('totalMiles')"
        @keyup.space.prevent="openDetail('totalMiles')"
      >
        <div class="asset-label">Total Miles</div>
        <div class="asset-value">{{ (asset.totalMiles || 0).toLocaleString() }}</div>
        <div class="asset-formula">= MAX(odometer) - MIN(odometer)</div>
      </div>
      <div
        class="asset-item clickable"
        role="button" tabindex="0"
        aria-label="Open Revenue per Mile breakdown"
        title="Click for breakdown"
        @click="openDetail('revenuePerMile')"
        @keyup.enter="openDetail('revenuePerMile')"
        @keyup.space.prevent="openDetail('revenuePerMile')"
      >
        <div class="asset-label">Revenue / Mile</div>
        <div class="asset-value" style="color: var(--accent);">{{ asset.revenuePerMile ? '$' + asset.revenuePerMile.toFixed(2) : '—' }}</div>
        <div class="asset-formula">= totalRevenue / totalMiles</div>
      </div>
      <div
        class="asset-item clickable"
        role="button" tabindex="0"
        aria-label="Open Cost per Mile breakdown"
        title="Click for breakdown"
        @click="openDetail('costPerMile')"
        @keyup.enter="openDetail('costPerMile')"
        @keyup.space.prevent="openDetail('costPerMile')"
      >
        <div class="asset-label">Cost / Mile</div>
        <div class="asset-value" style="color: var(--danger);">{{ asset.costPerMile ? '$' + asset.costPerMile.toFixed(2) : '—' }}</div>
        <div class="asset-formula">= totalExpenses / totalMiles</div>
      </div>
    </div>

    <div
      class="dep-bar-container clickable"
      role="button" tabindex="0"
      aria-label="Open Section 179 Depreciation explanation"
      title="Click for explanation"
      @click="openDetail('depreciation')"
      @keyup.enter="openDetail('depreciation')"
      @keyup.space.prevent="openDetail('depreciation')"
    >
      <div class="dep-bar-label">
        <span>Sec. 179 Depreciation (Year 1 &mdash; 100%)</span>
        <span>100% depreciated</span>
      </div>
      <div class="dep-bar">
        <div class="dep-bar-fill" style="width: 100%; background: var(--amber);"></div>
      </div>
    </div>

    <!-- Detail modal -->
    <MetricInfoDialog
      :open="!!detailType"
      :title="modalTitle"
      :subtitle="modalSubtitle"
      @update:open="v => { if (!v) detailType = '' }"
    >
      <!-- Total Miles -->
      <template v-if="detailType === 'totalMiles'">
        <div class="modal-breakdown">
          <div class="modal-explain">
            The total miles your truck(s) have been driven since the first odometer reading was captured.
          </div>
          <div class="step-label">The Calculation</div>
          <div class="modal-explain-sm">
            For each truck, take the highest odometer reading seen and subtract the earliest one. Sum across all your trucks.
          </div>
          <div class="modal-divider"></div>
          <div class="modal-row bold result">
            <span>Total Miles</span>
            <span class="val accent">{{ (asset.totalMiles || 0).toLocaleString() }} mi</span>
          </div>
          <div class="modal-callout info">
            Odometer readings come from Routemate ELD telemetry. If the truck wasn't on the road yet (no telemetry), this will read 0 until the first ping arrives.
          </div>
        </div>
      </template>

      <!-- Revenue per Mile -->
      <template v-if="detailType === 'revenuePerMile'">
        <div class="modal-breakdown">
          <div class="modal-explain">
            How much revenue your truck earned for every mile it drove. The industry's most common efficiency benchmark &mdash; if this dips, the truck is doing too much deadhead or too many low-rate loads.
          </div>
          <div class="step-label">The Calculation</div>
          <div class="modal-row">
            <span>Total Revenue</span>
            <span class="val accent">${{ impliedTotalRevenue.toLocaleString() }}</span>
          </div>
          <div class="modal-row deduct">
            <span>&divide; Total Miles</span>
            <span class="val">{{ (asset.totalMiles || 0).toLocaleString() }}</span>
          </div>
          <div class="modal-divider"></div>
          <div class="modal-row bold result">
            <span>Revenue / Mile</span>
            <span class="val accent">{{ asset.revenuePerMile ? '$' + asset.revenuePerMile.toFixed(2) : '—' }}</span>
          </div>
          <div class="modal-callout info">
            $1.80&ndash;$2.50/mi is typical for OTR (over-the-road) dry van freight. Below $1.50/mi is a red flag for unprofitable routes; above $2.50/mi suggests premium lanes.
          </div>
        </div>
      </template>

      <!-- Cost per Mile -->
      <template v-if="detailType === 'costPerMile'">
        <div class="modal-breakdown">
          <div class="modal-explain">
            How much it costs to run your truck for every mile it drives. This includes <strong>everything</strong> &mdash; driver pay, insurance, ELD, registration, road tax, maintenance reserve, fuel, tolls, and repairs.
          </div>
          <div class="step-label">The Calculation</div>
          <div class="modal-row">
            <span>Total Expenses</span>
            <span class="val danger">${{ impliedTotalExpenses.toLocaleString() }}</span>
          </div>
          <div class="modal-row deduct">
            <span>&divide; Total Miles</span>
            <span class="val">{{ (asset.totalMiles || 0).toLocaleString() }}</span>
          </div>
          <div class="modal-divider"></div>
          <div class="modal-row bold result">
            <span>Cost / Mile</span>
            <span class="val danger">{{ asset.costPerMile ? '$' + asset.costPerMile.toFixed(2) : '—' }}</span>
          </div>
          <div class="modal-callout info">
            For the truck to be profitable, Revenue / Mile must exceed Cost / Mile. The gap between the two is your gross margin per mile, before the 50/50 split.
          </div>
        </div>
      </template>

      <!-- Section 179 Depreciation -->
      <template v-if="detailType === 'depreciation'">
        <div class="modal-breakdown">
          <div class="modal-explain">
            Section 179 of the IRS tax code lets a business write off the full purchase price of qualifying equipment (including heavy trucks) in the year it's placed in service, rather than depreciating it over several years.
          </div>
          <div class="step-label">Why It Matters</div>
          <div class="modal-explain-sm">
            The truck is treated as <strong>100% depreciated</strong> for tax purposes in year 1. That means the cost of the truck reduces taxable income that same year &mdash; a significant deduction.
          </div>
          <div class="step-label">What It Means For You</div>
          <div class="modal-explain-sm">
            On paper, the truck has zero remaining book value. In reality, it still operates, generates revenue, and has resale value. The "100% depreciated" label is an IRS accounting concept, not a statement about the truck's condition.
          </div>
          <div class="modal-callout info">
            Talk to your tax advisor about how Section 179 applies to your specific situation &mdash; election rules and income limits apply.
          </div>
        </div>
      </template>
    </MetricInfoDialog>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'
import MetricInfoDialog from './MetricInfoDialog.vue'

const props = defineProps({
  asset: { type: Object, required: true },
  config: { type: Object, default: null },
})

const detailType = ref('')
function openDetail(type) { detailType.value = type }

// Imply totals from per-mile ratios (server doesn't return them on the asset object).
const impliedTotalRevenue = computed(() =>
  Math.round((props.asset?.revenuePerMile || 0) * (props.asset?.totalMiles || 0))
)
const impliedTotalExpenses = computed(() =>
  Math.round((props.asset?.costPerMile || 0) * (props.asset?.totalMiles || 0))
)

const MODAL_CONFIG = {
  totalMiles: { title: 'Total Miles Driven', subtitle: 'Cumulative miles across your fleet' },
  revenuePerMile: { title: 'Revenue per Mile', subtitle: 'How much each mile earned' },
  costPerMile: { title: 'Cost per Mile', subtitle: 'How much each mile costs to run' },
  depreciation: { title: 'Section 179 Depreciation', subtitle: 'How the truck is depreciated for tax purposes' },
}

const modalTitle = computed(() => MODAL_CONFIG[detailType.value]?.title || '')
const modalSubtitle = computed(() => MODAL_CONFIG[detailType.value]?.subtitle || '')
</script>

<style scoped>
.section {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 1.25rem;
  margin-bottom: 1.25rem;
}

.section-title {
  font-size: 0.95rem;
  font-weight: 700;
  margin-bottom: 1rem;
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.section-icon {
  width: 28px;
  height: 28px;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.9rem;
}

.asset-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 1rem;
}
@media (max-width: 600px) {
  .asset-grid { grid-template-columns: 1fr; }
}

.asset-item {
  padding: 0.85rem;
  border: 1px solid var(--border);
  border-radius: 8px;
  text-align: center;
}
.asset-item.clickable { cursor: pointer; transition: all 0.15s ease; }
.asset-item.clickable:hover { background: var(--accent-dim); box-shadow: 0 2px 12px rgba(0,0,0,0.08); }
.asset-item.clickable:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

.asset-label {
  font-size: 0.72rem;
  color: var(--text-dim);
  font-weight: 600;
  margin-bottom: 0.3rem;
}

.asset-value {
  font-family: 'JetBrains Mono', monospace;
  font-size: 1.1rem;
  font-weight: 700;
}

.title-status {
  color: var(--blue);
  font-size: 0.95rem;
}

.dep-bar-container {
  margin-top: 1rem;
  border-radius: 8px;
  padding: 0.4rem;
  margin-left: -0.4rem;
  margin-right: -0.4rem;
}
.dep-bar-container.clickable { cursor: pointer; transition: all 0.15s ease; }
.dep-bar-container.clickable:hover { background: var(--amber-dim); }
.dep-bar-container.clickable:focus-visible { outline: 2px solid var(--amber); outline-offset: 2px; }

.dep-bar-label {
  display: flex;
  justify-content: space-between;
  font-size: 0.75rem;
  color: var(--text-dim);
  margin-bottom: 0.3rem;
}

.dep-bar {
  height: 10px;
  background: var(--border);
  border-radius: 5px;
  overflow: hidden;
}

.dep-bar-fill {
  height: 100%;
  border-radius: 5px;
  transition: width 0.5s;
}
.asset-formula {
  font-size: 0.58rem; font-family: 'JetBrains Mono', monospace;
  color: var(--text-dim); opacity: 0.5; font-style: italic; margin-top: 0.15rem;
}
</style>
