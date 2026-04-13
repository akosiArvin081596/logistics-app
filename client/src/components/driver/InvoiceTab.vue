<template>
  <div class="invoice-tab">
    <!-- Week picker -->
    <div class="card week-picker">
      <div class="week-row">
        <button class="week-arrow" @click="prevWeek">&lsaquo;</button>
        <div class="week-label">
          <div class="week-title">{{ formatWeekDate(weekStart) }} - {{ formatWeekDate(weekEnd) }}</div>
          <div class="week-sub">{{ isCurrentWeek ? 'Current Week' : 'Past Week' }}</div>
        </div>
        <button class="week-arrow" :disabled="isCurrentWeek" @click="nextWeek">&rsaquo;</button>
      </div>
    </div>

    <!-- Deadline warning -->
    <div v-if="isCurrentWeek && pastDeadline" class="card deadline-warning">
      The submission deadline (Friday 6:00 PM CST) has passed for this week.
    </div>

    <!-- Generate button -->
    <button
      class="generate-btn"
      :disabled="generating"
      @click="handleGenerate"
    >
      {{ generating ? 'Generating...' : 'Generate Weekly Invoice' }}
    </button>

    <!-- Visible error banner so failures don't get silently swallowed by a
         disappearing toast. Shows the exact message from the server. -->
    <div v-if="generateError" class="generate-error">
      <div class="generate-error-title">
        <span class="warning-dot">&#9888;</span> Couldn't generate invoice
      </div>
      <div class="generate-error-msg">{{ generateError }}</div>
      <div class="generate-error-hint">
        Tip: try a different week using the arrows above if this week has no completed loads yet.
      </div>
    </div>

    <!-- Invoice history -->
    <div class="section-header" style="margin-top: 1rem;">
      Invoice History
      <span class="section-count">{{ invoices.length }}</span>
    </div>

    <div v-if="invoices.length === 0" class="empty-state">
      <div class="empty-icon">&#128203;</div>
      No invoices yet. Generate your first weekly invoice above.
    </div>

    <div v-else class="invoice-list">
      <InvoiceCard
        v-for="inv in invoices"
        :key="inv.id"
        :invoice="inv"
        @tap="handleTap"
      />
    </div>

    <!-- Invoice action popup -->
    <van-popup v-model:show="showActions" position="bottom" round :style="{ padding: '1rem' }">
      <div v-if="selectedInvoice" class="action-sheet">
        <div class="action-title">{{ selectedInvoice.invoice_number }}</div>
        <div class="action-subtitle">${{ selectedInvoice.total_earnings?.toFixed(2) }} - {{ selectedInvoice.status }}</div>
        <div class="action-buttons">
          <a :href="'/api/invoices/' + selectedInvoice.id + '/pdf'" target="_blank" class="action-btn">View PDF</a>
          <button
            v-if="selectedInvoice.status === 'Draft'"
            class="action-btn action-submit"
            :disabled="submitting"
            @click="handleSubmit"
          >
            {{ submitting ? 'Submitting...' : 'Submit & Send to Admin' }}
          </button>
        </div>
      </div>
    </van-popup>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'
import { Popup as VanPopup } from 'vant'
import { useDriverStore } from '../../stores/driver'
import { useToast } from '../../composables/useToast'
import InvoiceCard from './InvoiceCard.vue'

const driverStore = useDriverStore()
const { show: toast } = useToast()

const generating = ref(false)
const generateError = ref('')
const submitting = ref(false)
const showActions = ref(false)
const selectedInvoice = ref(null)

// Week navigation
const weekOffset = ref(0)

const weekRange = computed(() => {
  const now = new Date()
  // Shift by offset weeks
  const ref = new Date(now.getTime() - weekOffset.value * 7 * 86400000)
  const day = ref.getDay()
  const satOffset = day === 6 ? 0 : day + 1
  const start = new Date(ref)
  start.setDate(ref.getDate() - satOffset)
  start.setHours(0, 0, 0, 0)
  const end = new Date(start)
  end.setDate(start.getDate() + 6)
  end.setHours(23, 59, 59, 999)
  return { start, end }
})

const weekStart = computed(() => weekRange.value.start.toISOString().split('T')[0])
const weekEnd = computed(() => weekRange.value.end.toISOString().split('T')[0])
const isCurrentWeek = computed(() => weekOffset.value === 0)

const pastDeadline = computed(() => {
  const now = new Date()
  const fri = new Date(weekEnd.value + 'T18:00:00')
  return now > fri
})

const invoices = computed(() => driverStore.invoices || [])

function prevWeek() { weekOffset.value++ }
function nextWeek() { if (weekOffset.value > 0) weekOffset.value-- }

function formatWeekDate(dateStr) {
  const d = new Date(dateStr + 'T12:00:00')
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

async function handleGenerate() {
  generating.value = true
  generateError.value = ''
  try {
    const result = await driverStore.generateInvoice(weekEnd.value)
    if (result.isLate) {
      toast('Invoice generated (past deadline)', 'warning')
    } else {
      toast('Invoice generated successfully', 'success')
    }
  } catch (err) {
    // useApi wraps server errors into an Error with .message set to
    // the server's { error: ... } string. Surface it verbatim in the
    // inline banner so the driver can see why generation failed.
    const msg = err?.message || err?.response?.error || 'Failed to generate invoice'
    generateError.value = msg
    toast(msg, 'error')
  } finally {
    generating.value = false
  }
}

function handleTap(invoice) {
  selectedInvoice.value = invoice
  showActions.value = true
}

async function handleSubmit() {
  if (!selectedInvoice.value || submitting.value) return
  submitting.value = true
  try {
    await driverStore.submitInvoice(selectedInvoice.value.id)
    toast('Invoice submitted', 'success')
    showActions.value = false
  } catch (err) {
    toast(err.message || 'Failed to submit', 'error')
  } finally {
    submitting.value = false
  }
}
</script>

<style scoped>
.invoice-tab {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.week-picker { padding: 0.75rem 1rem; }
.week-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}
.week-arrow {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  border: 1px solid var(--bg);
  background: var(--card);
  font-size: 1.3rem;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  color: var(--text);
  flex-shrink: 0;
}
.week-arrow:disabled { opacity: 0.3; cursor: not-allowed; }
.week-label {
  flex: 1;
  text-align: center;
}
.week-title {
  font-weight: 700;
  font-size: 0.95rem;
}
.week-sub {
  font-size: 0.72rem;
  color: var(--text-dim);
}
.deadline-warning {
  padding: 0.6rem 1rem;
  background: #fef3c7;
  color: #92400e;
  font-size: 0.78rem;
  font-weight: 600;
  border-left: 3px solid #f59e0b;
}
.generate-btn {
  width: 100%;
  padding: 0.75rem;
  background: var(--accent);
  color: white;
  border: none;
  border-radius: 12px;
  font-weight: 700;
  font-size: 0.95rem;
  cursor: pointer;
}
.generate-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.generate-error {
  background: #fef2f2;
  border: 1px solid #fecaca;
  border-radius: 10px;
  padding: 0.85rem 1rem;
  margin-top: 0.75rem;
  color: #b91c1c;
}
.generate-error-title {
  font-size: 0.85rem;
  font-weight: 700;
  display: flex;
  align-items: center;
  gap: 0.4rem;
  margin-bottom: 0.3rem;
}
.warning-dot { font-size: 1rem; }
.generate-error-msg {
  font-size: 0.8rem;
  line-height: 1.4;
  margin-bottom: 0.35rem;
}
.generate-error-hint {
  font-size: 0.72rem;
  color: #991b1b;
  opacity: 0.85;
  font-style: italic;
}
.invoice-list {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}
.action-sheet { text-align: center; }
.action-title {
  font-weight: 700;
  font-size: 1rem;
  margin-bottom: 0.2rem;
}
.action-subtitle {
  font-size: 0.82rem;
  color: var(--text-dim);
  margin-bottom: 1rem;
}
.action-buttons {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.action-btn {
  display: block;
  width: 100%;
  padding: 0.7rem;
  border: 1px solid var(--bg);
  border-radius: 10px;
  background: var(--card);
  font-weight: 600;
  font-size: 0.9rem;
  text-align: center;
  text-decoration: none;
  color: var(--text);
  cursor: pointer;
}
.action-submit {
  background: var(--accent);
  color: white;
  border-color: var(--accent);
}
.action-submit:disabled { opacity: 0.5; }
.empty-state {
  text-align: center;
  padding: 2rem 1rem;
  color: var(--text-dim);
  font-size: 0.88rem;
}
.empty-icon {
  font-size: 2rem;
  margin-bottom: 0.5rem;
}
</style>
