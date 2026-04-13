<template>
  <div class="expenses-tab">
    <!-- Sub-tabs -->
    <div class="sub-tabs">
      <button
        v-for="tab in subTabs"
        :key="tab.key"
        :class="['sub-tab', { active: activeSubTab === tab.key }]"
        @click="activeSubTab = tab.key"
      >{{ tab.label }}</button>
    </div>

    <!-- ALL EXPENSES -->
    <div v-show="activeSubTab === 'all'" class="sub-panel">
      <!-- Download Receipts — Super Admin only.
           Streams a ZIP of every receipt file for a specific truck in a
           date range, plus a manifest.csv for accounting review. -->
      <div v-if="auth.isSuperAdmin" class="download-receipts-card">
        <div class="download-receipts-title">
          <span>Download Receipts (ZIP)</span>
          <span class="download-receipts-hint">Bundle all receipts for a truck &amp; date range</span>
        </div>
        <div class="download-receipts-row">
          <select v-model="downloadForm.truck" class="add-input" style="max-width:180px" aria-label="Truck unit">
            <option value="">Select Truck *</option>
            <option v-for="t in truckList" :key="t" :value="t">{{ t }}</option>
          </select>
          <input v-model="downloadForm.from" type="date" class="add-input" style="max-width:160px" :max="downloadForm.to || todayIso" aria-label="From date" />
          <input v-model="downloadForm.to" type="date" class="add-input" style="max-width:160px" :min="downloadForm.from" :max="todayIso" aria-label="To date" />
          <button class="btn btn-primary" :disabled="!canDownload || downloadLoading" @click="downloadReceipts">
            {{ downloadLoading ? 'Preparing...' : 'Download ZIP' }}
          </button>
        </div>
        <div v-if="downloadError" class="download-receipts-error">{{ downloadError }}</div>
      </div>

      <!-- Add Expense form — Super Admin / Dispatcher only -->
      <div v-if="canAddExpense" class="add-expense-card">
        <div class="add-expense-title">Log Expense</div>
        <div class="add-expense-row">
          <select v-model="addForm.driver" class="add-input">
            <option value="">Select Driver *</option>
            <option v-for="d in allDrivers" :key="d" :value="d">{{ d }}</option>
          </select>
          <select v-model="addForm.type" class="add-input">
            <option v-for="t in expenseTypes" :key="t" :value="t">{{ t }}</option>
          </select>
          <input v-model="addForm.amount" type="number" step="0.01" min="0" placeholder="Amount *" class="add-input" style="max-width:120px" />
          <input v-model="addForm.date" type="date" class="add-input" style="max-width:150px" />
          <button class="btn btn-primary add-btn" :disabled="addLoading" @click="submitExpense">{{ addLoading ? '...' : 'Add' }}</button>
        </div>
        <div class="add-expense-row">
          <input v-model="addForm.loadId" type="text" placeholder="Load ID (optional)" class="add-input" style="max-width:180px" />
          <input v-model="addForm.description" type="text" placeholder="Description (e.g., Tire repair paid via phone)" class="add-input" style="flex:1" />
        </div>
      </div>

      <template v-if="allLoading">
        <div class="skeleton skeleton-card"></div>
      </template>
      <template v-else>
        <div class="filter-row">
          <select v-model="allFilter.driver" class="filter-select" @change="loadAll">
            <option value="">All Drivers</option>
            <option v-for="d in allDrivers" :key="d" :value="d">{{ d }}</option>
          </select>
          <select v-model="allFilter.type" class="filter-select" @change="loadAll">
            <option value="">All Types</option>
            <option v-for="t in expenseTypes" :key="t" :value="t">{{ t }}</option>
          </select>
          <select v-model="allFilter.status" class="filter-select" @change="loadAll">
            <option value="">All Status</option>
            <option>Pending</option>
            <option>Approved</option>
            <option>Rejected</option>
          </select>
          <span class="filter-count">{{ allExpenses.length }} expenses</span>
        </div>

        <div v-if="allExpenses.length === 0" class="empty-msg">No expenses found.</div>
        <table v-else class="data-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Driver</th>
              <th>Type</th>
              <th>Description</th>
              <th>Amount</th>
              <th>Receipt</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="e in allExpenses" :key="e.id">
              <td class="mono-sm">{{ fmtDate(e.date) }}</td>
              <td>{{ e.driver }}</td>
              <td><span :class="['type-pill', 'type-' + e.type.toLowerCase()]">{{ e.type }}</span></td>
              <td class="desc-cell">{{ e.description || '\u2014' }}</td>
              <td class="mono-sm">${{ Number(e.amount).toLocaleString('en-US', { minimumFractionDigits: 2 }) }}</td>
              <td>
                <img v-if="e.photo_data" :src="e.photo_data" class="receipt-thumb" @click="previewImg = e.photo_data" />
                <span v-else class="dim">\u2014</span>
              </td>
              <td>
                <span :class="['status-pill', 'st-' + (e.status || 'Pending').toLowerCase()]">{{ e.status || 'Pending' }}</span>
              </td>
              <td class="action-cell">
                <template v-if="(e.status || 'Pending') === 'Pending'">
                  <button class="btn-approve" @click="setStatus(e.id, 'Approved')">Approve</button>
                  <button class="btn-reject" @click="setStatus(e.id, 'Rejected')">Reject</button>
                </template>
                <button v-else-if="e.status !== 'Pending'" class="btn-undo" @click="setStatus(e.id, 'Pending')">Undo</button>
              </td>
            </tr>
          </tbody>
        </table>
      </template>

      <!-- Receipt preview overlay -->
      <Teleport to="body">
        <div v-if="previewImg" class="preview-overlay" @click="previewImg = null">
          <img :src="previewImg" class="preview-img" />
        </div>
      </Teleport>
    </div>

    <!-- FUEL LOGS -->
    <div v-show="activeSubTab === 'fuel'" class="sub-panel">
      <template v-if="fuelLoading">
        <div class="skeleton skeleton-card"></div>
      </template>
      <template v-else>
        <div class="metrics-grid">
          <div class="metric-card">
            <div class="metric-label">Total Fuel Spend</div>
            <div class="metric-value">${{ fuel.totalFuelSpend?.toLocaleString() || 0 }}</div>
          </div>
          <div class="metric-card">
            <div class="metric-label">Total Gallons</div>
            <div class="metric-value">{{ fuel.totalGallons || 0 }}</div>
          </div>
          <div class="metric-card">
            <div class="metric-label">Avg $/Gallon</div>
            <div class="metric-value">${{ fuel.avgCostPerGallon || '—' }}</div>
          </div>
          <div class="metric-card">
            <div class="metric-label">Cost/Mile</div>
            <div class="metric-value">{{ fuel.costPerMile ? '$' + fuel.costPerMile : '—' }}</div>
          </div>
        </div>

        <!-- Savings target -->
        <div class="compliance-card">
          <div class="compliance-header">
            <span>Route Compliance — 15% Savings Target</span>
            <span :class="['compliance-badge', fuel.onTarget ? 'on-target' : 'off-target']">
              {{ fuel.onTarget ? 'On Target' : 'Below Target' }}
            </span>
          </div>
          <div class="progress-bar">
            <div
              class="progress-fill"
              :class="{ danger: !fuel.onTarget }"
              :style="{ width: Math.min(100, Math.max(0, (fuel.savingsVsNational / fuel.savingsTarget) * 100)) + '%' }"
            ></div>
          </div>
          <div class="compliance-detail">
            {{ fuel.savingsVsNational || 0 }}% vs national avg ($3.80/gal) — Target: {{ fuel.savingsTarget || 15 }}%
          </div>
        </div>

        <!-- Monthly trend -->
        <div v-if="fuel.monthlyData?.length" class="section-card">
          <div class="section-title">Monthly Fuel Spend</div>
          <table>
            <thead>
              <tr>
                <th>Month</th>
                <th>Spend</th>
                <th>Gallons</th>
                <th>$/Gal</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="m in fuel.monthlyData" :key="m.month">
                <td class="mono">{{ m.month }}</td>
                <td>${{ m.spend.toLocaleString() }}</td>
                <td>{{ m.gallons }}</td>
                <td>${{ m.avgPerGallon }}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- Recent fills -->
        <div v-if="fuel.recentFills?.length" class="section-card">
          <div class="section-title">Recent Fuel Fills</div>
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Driver</th>
                <th>Amount</th>
                <th>Gal</th>
                <th>Odo</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="f in fuel.recentFills" :key="f.id">
                <td class="mono">{{ f.date }}</td>
                <td>{{ f.driver }}</td>
                <td>${{ f.amount }}</td>
                <td>{{ f.gallons || '—' }}</td>
                <td class="mono">{{ f.odometer || '—' }}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div v-if="!fuel.recentFills?.length" class="empty-msg">
          No fuel data yet. Drivers log fuel expenses in their app.
        </div>
      </template>
    </div>

    <!-- MAINTENANCE SINKING FUND (Super Admin only) -->
    <div v-show="activeSubTab === 'maintenance' && auth.isSuperAdmin" class="sub-panel">
      <template v-if="maintLoading">
        <div class="skeleton skeleton-card"></div>
      </template>
      <template v-else>
        <div class="metrics-grid">
          <div class="metric-card accent">
            <div class="metric-label">Fund Balance</div>
            <div class="metric-value">${{ maint.balance?.toLocaleString() || 0 }}</div>
          </div>
          <div class="metric-card">
            <div class="metric-label">Monthly Target</div>
            <div class="metric-value">${{ maint.monthlyTarget?.toLocaleString() || 800 }}/mo</div>
          </div>
          <div class="metric-card">
            <div class="metric-label">Total Contributed</div>
            <div class="metric-value">${{ maint.totalContributed?.toLocaleString() || 0 }}</div>
          </div>
          <div class="metric-card">
            <div class="metric-label">Total Spent (PM)</div>
            <div class="metric-value">${{ maint.totalSpent?.toLocaleString() || 0 }}</div>
          </div>
        </div>

        <!-- Add entry form -->
        <div class="section-card">
          <div class="section-title">Log Entry</div>
          <div class="inline-form">
            <select v-model="maintForm.type" class="form-select">
              <option value="contribution">Contribution</option>
              <option value="service">PM Service</option>
            </select>
            <input v-model="maintForm.amount" type="number" step="0.01" min="0" placeholder="Amount" class="form-input" />
            <input v-model="maintForm.truck" type="text" placeholder="Truck" class="form-input sm" />
            <input v-model="maintForm.date" type="date" class="form-input" />
            <input v-model="maintForm.description" type="text" placeholder="Description" class="form-input wide" />
            <button class="btn btn-primary" :disabled="maintSubmitting" @click="submitMaintEntry">Add</button>
          </div>
        </div>

        <!-- History -->
        <div v-if="maint.entries?.length" class="section-card">
          <div class="section-title">Fund History</div>
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Type</th>
                <th>Amount</th>
                <th>Truck</th>
                <th>Description</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="e in maint.entries" :key="e.id">
                <td class="mono">{{ e.date }}</td>
                <td>
                  <span :class="['type-badge', e.type]">
                    {{ e.type === 'contribution' ? 'Deposit' : 'PM Service' }}
                  </span>
                </td>
                <td :class="e.type === 'service' ? 'text-danger' : 'text-accent'">
                  {{ e.type === 'service' ? '-' : '+' }}${{ e.amount }}
                </td>
                <td>{{ e.truck || '—' }}</td>
                <td class="desc-cell">{{ e.description || '—' }}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div v-if="!maint.entries?.length" class="empty-msg">
          No maintenance fund entries yet. Use the form above to log contributions and PM services.
        </div>
      </template>
    </div>

    <!-- IFTA / COMPLIANCE (Super Admin only) -->
    <div v-show="activeSubTab === 'ifta' && auth.isSuperAdmin" class="sub-panel">
      <template v-if="iftaLoading">
        <div class="skeleton skeleton-card"></div>
      </template>
      <template v-else>
        <!-- IFTA Mileage -->
        <div class="metrics-grid">
          <div class="metric-card">
            <div class="metric-label">Total Miles (GPS)</div>
            <div class="metric-value">{{ ifta.totalMiles?.toLocaleString() || 0 }}</div>
          </div>
          <div class="metric-card">
            <div class="metric-label">States Tracked</div>
            <div class="metric-value">{{ ifta.states?.length || 0 }}</div>
          </div>
          <div class="metric-card">
            <div class="metric-label">Active Drivers</div>
            <div class="metric-value">{{ ifta.driverCount || 0 }}</div>
          </div>
          <div class="metric-card">
            <div class="metric-label">Fees Pending</div>
            <div class="metric-value">${{ fees.totalDue?.toLocaleString() || 0 }}</div>
          </div>
        </div>

        <!-- State mileage table -->
        <div v-if="ifta.states?.length" class="section-card">
          <div class="section-title">Miles by State (IFTA)</div>
          <table>
            <thead>
              <tr>
                <th>State</th>
                <th>Miles</th>
                <th>%</th>
                <th>Drivers</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="s in ifta.states" :key="s.state">
                <td class="mono bold">{{ s.state }}</td>
                <td>{{ s.miles.toLocaleString() }}</td>
                <td>{{ s.pct }}%</td>
                <td>{{ s.drivers.join(', ') }}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div v-if="!ifta.states?.length" class="empty-msg">
          No GPS mileage data yet. Miles are calculated from driver location reports.
        </div>

        <!-- Compliance Fees -->
        <div class="section-card">
          <div class="section-title">Government Fees (2290 / Registration / IFTA)</div>
          <div class="inline-form">
            <select v-model="feeForm.type" class="form-select">
              <option value="2290">2290 (HVUT)</option>
              <option value="Registration">Registration</option>
              <option value="IFTA">IFTA Quarterly</option>
              <option value="IRP">IRP</option>
              <option value="Other">Other</option>
            </select>
            <input v-model="feeForm.amount" type="number" step="0.01" min="0" placeholder="Amount" class="form-input" />
            <input v-model="feeForm.truck" type="text" placeholder="Truck" class="form-input sm" />
            <input v-model="feeForm.dueDate" type="date" class="form-input" />
            <input v-model="feeForm.description" type="text" placeholder="Description" class="form-input wide" />
            <button class="btn btn-primary" :disabled="feeSubmitting" @click="submitFee">Add</button>
          </div>
        </div>

        <div v-if="fees.fees?.length" class="section-card">
          <div class="section-title">Fee Schedule</div>
          <table>
            <thead>
              <tr>
                <th>Type</th>
                <th>Amount</th>
                <th>Truck</th>
                <th>Due Date</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="f in fees.fees" :key="f.id">
                <td><span class="type-badge fee">{{ f.type }}</span></td>
                <td>${{ f.amount }}</td>
                <td>{{ f.truck || '—' }}</td>
                <td class="mono">{{ f.dueDate }}</td>
                <td>
                  <span :class="['status-pill', f.status.toLowerCase()]">{{ f.status }}</span>
                </td>
                <td>
                  <button
                    v-if="f.status === 'Pending'"
                    class="btn btn-sm"
                    @click="markFeePaid(f.id)"
                  >Mark Paid</button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue'
import { useApi } from '../../composables/useApi'
import { useToast } from '../../composables/useToast'
import { useAuthStore } from '../../stores/auth'

const api = useApi()
const { show: toast } = useToast()
const auth = useAuthStore()

const allSubTabs = [
  { key: 'all', label: 'All Expenses' },
  { key: 'fuel', label: 'Fuel Logs' },
  { key: 'maintenance', label: 'Maintenance Fund', adminOnly: true },
  { key: 'ifta', label: 'IFTA / Compliance', adminOnly: true },
]

const subTabs = computed(() =>
  allSubTabs.filter(t => !t.adminOnly || auth.isSuperAdmin)
)

const activeSubTab = ref('all')

// All expenses
const allExpenses = ref([])
const allLoading = ref(true)
const allDrivers = ref([])
const previewImg = ref(null)
const expenseTypes = ['Fuel', 'Repair', 'Maintenance', 'Wear & Tear', 'Toll', 'Food', 'Other']
const allFilter = reactive({ driver: '', type: '', status: '' })

// Add Expense form (Super Admin / Dispatcher only)
const canAddExpense = computed(() => auth.isSuperAdmin || auth.user?.role === 'Dispatcher')
const addForm = reactive({ driver: '', type: 'Fuel', amount: '', date: new Date().toISOString().slice(0, 10), loadId: '', description: '' })
const addLoading = ref(false)

// Download Receipts (Super Admin only) — ZIP bundle endpoint
const truckList = ref([])
// Computed so a long-lived tab that crosses midnight still clamps correctly.
const todayIso = computed(() => new Date().toISOString().slice(0, 10))
const downloadForm = reactive({ truck: '', from: '', to: '' })
const downloadLoading = ref(false)
const downloadError = ref('')
const canDownload = computed(() =>
  downloadForm.truck && downloadForm.from && downloadForm.to && downloadForm.to >= downloadForm.from
)

async function loadTruckList() {
  if (!auth.isSuperAdmin) return
  try {
    const res = await api.get('/api/trucks')
    const rows = res.data || res.trucks || res || []
    const units = rows.map(t => t.UnitNumber || t.unit_number || t.unit).filter(Boolean)
    truckList.value = [...new Set(units)].sort()
  } catch (err) {
    console.error('loadTruckList failed:', err)
    downloadError.value = 'Could not load truck list. Refresh to retry.'
  }
}

async function downloadReceipts() {
  downloadError.value = ''
  if (!canDownload.value) {
    downloadError.value = 'Pick a truck and a valid date range first.'
    return
  }
  downloadLoading.value = true
  try {
    // HEAD-style probe via fetch so we can surface JSON errors (404/400)
    // to the user instead of a broken file download.
    const qs = new URLSearchParams({
      truck: downloadForm.truck,
      from: downloadForm.from,
      to: downloadForm.to,
    }).toString()
    const url = `/api/expenses/receipts-download?${qs}`
    const res = await fetch(url, { credentials: 'include' })
    if (!res.ok) {
      let msg = `Download failed (${res.status})`
      try { const j = await res.json(); if (j?.error) msg = j.error } catch { /* not JSON */ }
      downloadError.value = msg
      return
    }
    const blob = await res.blob()
    const filename = `${downloadForm.truck}-receipts-${downloadForm.from}-to-${downloadForm.to}.zip`
    const link = document.createElement('a')
    link.href = URL.createObjectURL(blob)
    link.download = filename
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(link.href)
    toast('Receipt bundle downloaded', 'success')
  } catch (err) {
    downloadError.value = err?.message || 'Failed to download receipts'
  } finally {
    downloadLoading.value = false
  }
}

async function submitExpense() {
  if (!addForm.driver || !addForm.type || !addForm.amount || !addForm.date) {
    toast('Fill in Driver, Type, Amount, and Date', 'error'); return
  }
  const parsedAmt = parseFloat(addForm.amount)
  if (isNaN(parsedAmt) || parsedAmt <= 0) {
    toast('Amount must be greater than zero', 'error'); return
  }
  addLoading.value = true
  try {
    await api.post('/api/expenses', {
      driver: addForm.driver,
      type: addForm.type,
      amount: parseFloat(addForm.amount),
      date: addForm.date,
      loadId: addForm.loadId || '',
      description: addForm.description || '',
      photoData: '',
      gallons: 0,
      odometer: 0,
    })
    toast('Expense logged')
    addForm.driver = ''; addForm.amount = ''; addForm.loadId = ''; addForm.description = ''
    await loadAll()
  } catch (err) {
    toast(err.message || 'Failed to log expense', 'error')
  } finally {
    addLoading.value = false
  }
}

async function loadAll() {
  allLoading.value = true
  try {
    const params = new URLSearchParams()
    if (allFilter.driver) params.set('driver', allFilter.driver)
    if (allFilter.type) params.set('type', allFilter.type)
    if (allFilter.status) params.set('status', allFilter.status)
    const qs = params.toString() ? `?${params.toString()}` : ''
    const data = await api.get(`/api/expenses/all${qs}`)
    allExpenses.value = data.expenses || []
    // Build driver list from drivers directory (not from expenses — new drivers with no expenses would be missing)
    if (allDrivers.value.length === 0) {
      try {
        const dd = await api.get('/api/drivers-directory')
        const names = (dd.data || []).map(d => d.Driver || d.driver_name).filter(Boolean)
        allDrivers.value = [...new Set(names)].sort()
      } catch {
        // Fallback: derive from existing expenses
        const names = new Set(allExpenses.value.map(e => e.driver).filter(Boolean))
        allDrivers.value = [...names].sort()
      }
    }
  } catch { /* empty */ }
  allLoading.value = false
}

async function setStatus(id, status) {
  try {
    await api.put(`/api/expenses/${id}/status`, { status })
    const exp = allExpenses.value.find(e => e.id === id)
    if (exp) exp.status = status
    toast(status === 'Approved' ? 'Expense approved' : status === 'Rejected' ? 'Expense rejected' : 'Status reset', 'success')
  } catch {
    toast('Failed to update status', 'error')
  }
}

function fmtDate(d) {
  if (!d) return '\u2014'
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

// Fuel analytics
const fuel = ref({})
const fuelLoading = ref(true)

// Maintenance fund
const maint = ref({})
const maintLoading = ref(true)
const maintSubmitting = ref(false)
const maintForm = reactive({
  type: 'contribution',
  amount: '',
  truck: '',
  date: new Date().toISOString().split('T')[0],
  description: '',
})

// IFTA / Compliance
const ifta = ref({})
const iftaLoading = ref(true)
const fees = ref({})
const feeSubmitting = ref(false)
const feeForm = reactive({
  type: '2290',
  amount: '',
  truck: '',
  dueDate: '',
  description: '',
})

async function loadFuel() {
  fuelLoading.value = true
  try {
    fuel.value = await api.get('/api/expenses/fuel-analytics')
  } catch { /* empty */ }
  fuelLoading.value = false
}

async function loadMaintenance() {
  maintLoading.value = true
  try {
    maint.value = await api.get('/api/maintenance-fund')
  } catch { /* empty */ }
  maintLoading.value = false
}

async function loadIfta() {
  iftaLoading.value = true
  try {
    const [iftaData, feesData] = await Promise.all([
      api.get('/api/compliance/ifta'),
      api.get('/api/compliance/fees'),
    ])
    ifta.value = iftaData
    fees.value = feesData
  } catch { /* empty */ }
  iftaLoading.value = false
}

async function submitMaintEntry() {
  if (!maintForm.amount || !maintForm.date) {
    toast('Enter amount and date', 'error')
    return
  }
  maintSubmitting.value = true
  try {
    await api.post('/api/maintenance-fund', { ...maintForm })
    toast(maintForm.type === 'contribution' ? 'Contribution logged' : 'PM service logged', 'success')
    maintForm.amount = ''
    maintForm.description = ''
    maintForm.truck = ''
    await loadMaintenance()
  } catch {
    toast('Failed to save entry', 'error')
  }
  maintSubmitting.value = false
}

async function submitFee() {
  if (!feeForm.amount || !feeForm.dueDate) {
    toast('Enter amount and due date', 'error')
    return
  }
  feeSubmitting.value = true
  try {
    await api.post('/api/compliance/fees', { ...feeForm })
    toast('Fee added', 'success')
    feeForm.amount = ''
    feeForm.description = ''
    feeForm.truck = ''
    feeForm.dueDate = ''
    await loadIfta()
  } catch {
    toast('Failed to save fee', 'error')
  }
  feeSubmitting.value = false
}

async function markFeePaid(id) {
  try {
    await api.put(`/api/compliance/fees/${id}`, {
      paidDate: new Date().toISOString().split('T')[0],
    })
    toast('Fee marked as paid', 'success')
    await loadIfta()
  } catch {
    toast('Failed to update fee', 'error')
  }
}

onMounted(() => {
  loadAll()
  loadFuel()
  if (auth.isSuperAdmin) {
    loadMaintenance()
    loadIfta()
    loadTruckList()
  }
})
</script>

<style scoped>
.expenses-tab {
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}

.sub-tabs {
  display: flex;
  gap: 0;
  border-bottom: 1px solid var(--border);
  padding: 0 1rem;
  flex-shrink: 0;
}

.sub-tab {
  padding: 0.6rem 1rem;
  border: none;
  background: transparent;
  font-family: 'DM Sans', sans-serif;
  font-size: 0.8rem;
  font-weight: 600;
  color: var(--text-dim);
  cursor: pointer;
  border-bottom: 2px solid transparent;
  transition: all 0.15s;
}

.sub-tab:hover { color: var(--text); }
.sub-tab.active { color: var(--accent); border-bottom-color: var(--accent); }

.sub-panel {
  flex: 1;
  overflow-y: auto;
  padding: 1.25rem;
}

/* Metrics grid */
.metrics-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 0.75rem;
  margin-bottom: 1rem;
}

.metric-card {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 0.85rem 1rem;
}

.metric-card.accent {
  border-color: var(--accent);
  background: var(--accent-dim);
}

.metric-label {
  font-size: 0.7rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-dim);
  margin-bottom: 0.25rem;
}

.metric-value {
  font-family: 'JetBrains Mono', monospace;
  font-size: 1.15rem;
  font-weight: 700;
}

/* Compliance card */
.compliance-card {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 1rem;
  margin-bottom: 1rem;
}

.compliance-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 0.82rem;
  font-weight: 600;
  margin-bottom: 0.6rem;
}

.compliance-badge {
  font-size: 0.7rem;
  font-weight: 700;
  padding: 0.2rem 0.6rem;
  border-radius: 10px;
}

.compliance-badge.on-target {
  background: rgba(16,185,129,0.15);
  color: #059669;
}

.compliance-badge.off-target {
  background: var(--danger-dim);
  color: var(--danger);
}

.progress-bar {
  height: 8px;
  background: var(--border);
  border-radius: 4px;
  overflow: hidden;
  margin-bottom: 0.4rem;
}

.progress-fill {
  height: 100%;
  background: var(--accent);
  border-radius: 4px;
  transition: width 0.3s ease;
}

.progress-fill.danger {
  background: var(--danger);
}

.compliance-detail {
  font-size: 0.72rem;
  color: var(--text-dim);
}

/* Section cards */
.section-card {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 1rem;
  margin-bottom: 1rem;
}

.section-title {
  font-size: 0.82rem;
  font-weight: 700;
  margin-bottom: 0.75rem;
}

/* Inline form */
.inline-form {
  display: flex;
  gap: 0.5rem;
  align-items: center;
  flex-wrap: wrap;
}

.inline-form .form-select,
.inline-form .form-input {
  padding: 0.45rem 0.6rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  font-family: inherit;
  font-size: 0.8rem;
  background: var(--surface);
  color: var(--text);
  outline: none;
}

.inline-form .form-select { min-width: 130px; }
.inline-form .form-input { width: 100px; }
.inline-form .form-input.sm { width: 80px; }
.inline-form .form-input.wide { flex: 1; min-width: 140px; }

.btn {
  padding: 0.45rem 0.85rem;
  border: none;
  border-radius: var(--radius);
  font-family: inherit;
  font-size: 0.8rem;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s;
  white-space: nowrap;
}

.btn-primary {
  background: var(--accent);
  color: #fff;
}

.btn-primary:hover { opacity: 0.9; }
.btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }

.btn-sm {
  padding: 0.3rem 0.6rem;
  font-size: 0.72rem;
  background: var(--surface-hover);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: var(--radius);
}

.btn-sm:hover { background: var(--accent-dim); color: var(--accent); }

/* Tables */
table { width: 100%; border-collapse: collapse; }
thead { background: var(--surface-hover); }
th {
  padding: 0.55rem 0.75rem;
  text-align: left;
  font-size: 0.68rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-dim);
  border-bottom: 1px solid var(--border);
}
td {
  padding: 0.5rem 0.75rem;
  font-size: 0.82rem;
  border-bottom: 1px solid var(--border);
}
tr:last-child td { border-bottom: none; }
tr:hover td { background: var(--surface-hover); }

.mono { font-family: 'JetBrains Mono', monospace; font-size: 0.78rem; }
.bold { font-weight: 700; }
.text-danger { color: var(--danger); }
.text-accent { color: var(--accent); }

.type-badge {
  display: inline-block;
  font-size: 0.68rem;
  font-weight: 600;
  padding: 0.15rem 0.5rem;
  border-radius: 8px;
}

.type-badge.contribution { background: var(--accent-dim); color: var(--accent); }
.type-badge.service { background: var(--blue-dim); color: var(--blue); }
.type-badge.fee { background: var(--amber-dim); color: var(--amber); }

.status-pill {
  display: inline-block;
  font-size: 0.68rem;
  font-weight: 600;
  padding: 0.15rem 0.5rem;
  border-radius: 8px;
}

.status-pill.pending { background: var(--amber-dim); color: var(--amber); }
.status-pill.paid { background: rgba(16,185,129,0.15); color: #059669; }

.desc-cell {
  max-width: 200px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.empty-msg {
  text-align: center;
  color: var(--text-dim);
  font-size: 0.85rem;
  padding: 2rem 1rem;
}

/* Skeleton */
.skeleton {
  background: linear-gradient(90deg, var(--bg) 25%, var(--surface-hover) 50%, var(--bg) 75%);
  background-size: 200% 100%;
  animation: shimmer 1.5s infinite;
  border-radius: var(--radius);
}
.skeleton-card { height: 120px; margin-bottom: 0.75rem; }

@keyframes shimmer {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}

/* All Expenses tab */
.filter-row {
  display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap;
  padding: 0.75rem 1rem; border-bottom: 1px solid var(--border);
}
.filter-select {
  padding: 0.35rem 0.6rem; border: 1px solid var(--border); border-radius: 6px;
  font-family: inherit; font-size: 0.78rem; background: var(--bg); color: var(--text);
}
.filter-count {
  margin-left: auto; font-size: 0.72rem; color: var(--text-dim);
  font-family: 'JetBrains Mono', monospace;
}
.mono-sm { font-family: 'JetBrains Mono', monospace; font-size: 0.75rem; }
.dim { color: var(--text-dim); }
.desc-cell { max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.type-pill {
  display: inline-flex; padding: 0.12rem 0.5rem; border-radius: 10px;
  font-size: 0.66rem; font-weight: 600; text-transform: uppercase;
  letter-spacing: 0.04em;
}
.type-fuel { background: var(--blue-dim, rgba(59,130,246,0.12)); color: var(--blue, #3b82f6); }
.type-toll { background: var(--amber-dim); color: var(--amber); }
.type-repair { background: var(--danger-dim); color: var(--danger); }
.type-food { background: var(--accent-dim); color: var(--accent); }
.type-other { background: var(--bg); color: var(--text-dim); }

.status-pill {
  display: inline-flex; padding: 0.12rem 0.5rem; border-radius: 10px;
  font-size: 0.66rem; font-weight: 600;
}
.st-pending { background: var(--amber-dim); color: var(--amber); }
.st-approved { background: var(--accent-dim); color: var(--accent); }
.st-rejected { background: var(--danger-dim); color: var(--danger); }

.receipt-thumb {
  width: 36px; height: 28px; object-fit: cover; border-radius: 4px;
  cursor: pointer; transition: opacity 0.15s;
}
.receipt-thumb:hover { opacity: 0.7; }

.action-cell { white-space: nowrap; }
.btn-approve, .btn-reject, .btn-undo {
  padding: 0.22rem 0.55rem; font-size: 0.68rem; font-weight: 600;
  border-radius: 5px; border: none; cursor: pointer; font-family: inherit;
  transition: opacity 0.15s;
}
.btn-approve { background: var(--accent-dim); color: var(--accent); margin-right: 0.25rem; }
.btn-reject { background: var(--danger-dim); color: var(--danger); }
.btn-undo { background: var(--bg); color: var(--text-dim); border: 1px solid var(--border); }
.btn-approve:hover, .btn-reject:hover, .btn-undo:hover { opacity: 0.7; }

.preview-overlay {
  position: fixed; inset: 0; background: rgba(0,0,0,0.7);
  display: flex; align-items: center; justify-content: center;
  z-index: 300; cursor: pointer;
}
.preview-img { max-width: 90vw; max-height: 85vh; border-radius: 8px; }

/* Add Expense form */
.add-expense-card {
  background: var(--bg); border: 1px solid var(--border); border-radius: 10px;
  padding: 1rem; margin-bottom: 1rem;
}
.add-expense-title {
  font-size: 0.72rem; font-weight: 700; color: var(--text-dim);
  text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 0.6rem;
}
.add-expense-row {
  display: flex; gap: 0.5rem; margin-bottom: 0.5rem; flex-wrap: wrap; align-items: center;
}
.add-expense-row:last-child { margin-bottom: 0; }
.add-input {
  padding: 0.4rem 0.6rem; border: 1px solid var(--border); border-radius: 6px;
  font-family: inherit; font-size: 0.8rem; background: var(--surface); color: var(--text);
  min-width: 120px;
}
.add-input:focus { outline: none; border-color: var(--blue); }
.add-btn {
  padding: 0.4rem 1rem; font-size: 0.8rem; font-weight: 600; border-radius: 6px;
  border: none; background: var(--blue); color: #fff; cursor: pointer;
}
.add-btn:hover { opacity: 0.9; }
.add-btn:disabled { opacity: 0.5; cursor: default; }

/* Download Receipts (Super Admin) */
.download-receipts-card {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 1rem;
  margin-bottom: 1rem;
}
.download-receipts-title {
  display: flex; align-items: baseline; gap: 0.5rem; flex-wrap: wrap;
  font-size: 0.72rem; font-weight: 700; color: var(--text-dim);
  text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 0.6rem;
}
.download-receipts-hint {
  font-size: 0.68rem; font-weight: 500; text-transform: none;
  color: var(--text-dim); opacity: 0.7; letter-spacing: 0;
}
.download-receipts-row {
  display: flex; gap: 0.5rem; flex-wrap: wrap; align-items: center;
}
.download-receipts-error {
  margin-top: 0.5rem;
  font-size: 0.75rem;
  color: #b91c1c;
  background: #fef2f2;
  border: 1px solid #fecaca;
  padding: 0.4rem 0.6rem;
  border-radius: 6px;
}
</style>
