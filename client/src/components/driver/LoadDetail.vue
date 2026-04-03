<template>
  <div class="load-detail">
    <!-- Top bar with back button -->
    <div class="detail-topbar">
      <van-button size="small" @click="$emit('back')">&#8592; Back</van-button>
      <span class="topbar-title">{{ loadId || 'Load Details' }}</span>
      <StatusBadge :status="status" />
    </div>

    <!-- Route summary -->
    <div v-if="route" class="route-banner">
      <span class="route-icon">&#128205;</span>
      <span class="route-text">{{ route }}</span>
    </div>

    <!-- Route Map (separate collapse) -->
    <van-collapse v-model="openSections" class="detail-collapse" :border="false">
      <van-collapse-item title="Route Map" name="map">
        <DriverRouteMap
          ref="routeMapRef"
          :load="load"
          :headers="headers"
          :driver-position="driverPosition"
        />
      </van-collapse-item>
    </van-collapse>

    <!-- Main accordion sections -->
    <van-collapse v-model="openSections" class="detail-collapse" :border="false">
      <van-collapse-item title="Truck Details" name="truck">
        <template v-if="truck">
          <div class="truck-detail-card">
            <img v-if="truck.photo" :src="truck.photo" class="truck-photo" />
            <div class="truck-fields">
              <van-cell title="Unit #" :value="truck.unit_number || '\u2014'" />
              <van-cell title="Make / Model" :value="[truck.make, truck.model].filter(Boolean).join(' ') || '\u2014'" />
              <van-cell title="Year" :value="truck.year || '\u2014'" />
              <van-cell title="VIN" :value="truck.vin || '\u2014'" />
              <van-cell title="License Plate" :value="truck.license_plate || '\u2014'" />
              <van-cell title="Status">
                <template #value>
                  <span :class="['truck-status', 'ts-' + (truck.status || 'Active').toLowerCase()]">{{ truck.status || 'Active' }}</span>
                </template>
              </van-cell>
            </div>
          </div>
        </template>
        <van-empty v-else description="No truck assigned to this driver" image="search" :image-size="60" />
      </van-collapse-item>

      <van-collapse-item title="Pickup Details" name="pickup">
        <template v-if="pickupFields.length">
          <van-cell
            v-for="f in pickupFields"
            :key="f.header"
            :title="f.label"
            :border="true"
          >
            <template #value>
              <div class="cell-value-row">
                <span>{{ f.value || '\u2014' }}</span>
                <button v-if="isAddress(f.header) && f.value && pickupCoords" class="copy-btn" @click.stop="focusMapOn(pickupCoords)">
                  <span class="map-icon">&#128205;</span>
                </button>
                <button v-if="isAddress(f.header) && f.value" class="copy-btn" @click.stop="copyText(f.value)">
                  <span v-if="copiedField === f.header" class="copied-text">Copied</span>
                  <span v-else class="copy-icon">&#128203;</span>
                </button>
              </div>
            </template>
          </van-cell>
        </template>
        <van-empty v-else description="No pickup details available" image="search" :image-size="60" />
      </van-collapse-item>

      <van-collapse-item title="Drop-off Details" name="dropoff">
        <template v-if="dropoffFields.length">
          <van-cell
            v-for="f in dropoffFields"
            :key="f.header"
            :title="f.label"
            :border="true"
          >
            <template #value>
              <div class="cell-value-row">
                <span>{{ f.value || '\u2014' }}</span>
                <button v-if="isAddress(f.header) && f.value && dropoffCoords" class="copy-btn" @click.stop="focusMapOn(dropoffCoords)">
                  <span class="map-icon">&#128205;</span>
                </button>
                <button v-if="isAddress(f.header) && f.value" class="copy-btn" @click.stop="copyText(f.value)">
                  <span v-if="copiedField === f.header" class="copied-text">Copied</span>
                  <span v-else class="copy-icon">&#128203;</span>
                </button>
              </div>
            </template>
          </van-cell>
        </template>
        <van-empty v-else description="No drop-off details available" image="search" :image-size="60" />
      </van-collapse-item>

      <van-collapse-item title="Documents" name="documents">
        <DocumentList :load-id="loadId" />
      </van-collapse-item>

      <van-collapse-item title="Expenses" name="expenses">
        <div class="expenses-section">
          <ExpenseForm
            v-if="isActiveLoad"
            :loads="[load]"
            :driver-name="driverName"
            :headers="headers"
            @submit="$emit('expense-submit', $event)"
          />
          <div v-if="loadExpenses.length > 0" class="expense-history">
            <div class="expense-history-label">Expense History</div>
            <ExpenseCard v-for="exp in loadExpenses" :key="exp.id" :expense="exp" />
          </div>
          <van-empty v-else-if="!isActiveLoad" description="No expenses for this load" image="search" :image-size="60" />
        </div>
      </van-collapse-item>
    </van-collapse>

    <!-- Accept / Reject buttons for dispatched loads -->
    <div v-if="showResponseButtons" class="load-response-actions">
      <van-button type="danger" plain block @click="$emit('decline', load)">Reject Load</van-button>
      <van-button type="primary" block @click="$emit('accept', load)">Accept Load</van-button>
    </div>
    <div v-else-if="showAcceptedBadge" class="load-accepted-banner">
      <span>&#10003; Load Accepted</span>
    </div>

  </div>
</template>

<script setup>
import { computed, ref } from 'vue'
import { Collapse as VanCollapse, CollapseItem as VanCollapseItem, Cell as VanCell, Button as VanButton, Empty as VanEmpty } from 'vant'
import StatusBadge from '../shared/StatusBadge.vue'
import DocumentList from './DocumentList.vue'
import DriverRouteMap from './DriverRouteMap.vue'
import ExpenseForm from './ExpenseForm.vue'
import ExpenseCard from './ExpenseCard.vue'

const props = defineProps({
  load: { type: Object, required: true },
  headers: { type: Array, default: () => [] },
  driverName: { type: String, default: '' },
  hasActiveJob: { type: Boolean, default: false },
  driverPosition: { type: Object, default: null },
  truck: { type: Object, default: null },
  loadExpenses: { type: Array, default: () => [] },
})

const emit = defineEmits(['back', 'status-update', 'uploaded', 'accept', 'decline', 'expense-submit'])

const openSections = ref(['map'])
const copiedField = ref(null)
const routeMapRef = ref(null)

function isAddress(header) {
  return /address|addr|location/i.test(header)
}

const pickupCoords = computed(() => {
  const latCol = (props.headers || []).find(h => /origin.*lat|pickup.*lat|shipper.*lat/i.test(h))
  const lngCol = (props.headers || []).find(h => /origin.*l(on|ng)|pickup.*l(on|ng)|shipper.*l(on|ng)/i.test(h))
  if (!latCol || !lngCol) return null
  const lat = parseFloat(props.load[latCol])
  const lng = parseFloat(props.load[lngCol])
  return !isNaN(lat) && !isNaN(lng) ? [lat, lng] : null
})

const dropoffCoords = computed(() => {
  const latCol = (props.headers || []).find(h => /dest.*lat|drop.*lat|receiver.*lat|delivery.*lat/i.test(h))
  const lngCol = (props.headers || []).find(h => /dest.*l(on|ng)|drop.*l(on|ng)|receiver.*l(on|ng)|delivery.*l(on|ng)/i.test(h))
  if (!latCol || !lngCol) return null
  const lat = parseFloat(props.load[latCol])
  const lng = parseFloat(props.load[lngCol])
  return !isNaN(lat) && !isNaN(lng) ? [lat, lng] : null
})

function focusMapOn(coords) {
  if (!openSections.value.includes('map')) {
    openSections.value = [...openSections.value, 'map']
  }
  setTimeout(() => {
    routeMapRef.value?.focusOn(coords[0], coords[1])
  }, 150)
}

function copyText(text) {
  navigator.clipboard.writeText(text).then(() => {
    // Find which field was copied to show "Copied" feedback
    const all = [...pickupFields.value, ...dropoffFields.value]
    const field = all.find(f => f.value === text)
    if (field) {
      copiedField.value = field.header
      setTimeout(() => { copiedField.value = null }, 1500)
    }
  })
}

function findCol(headers, regex) {
  return (headers || []).find((h) => regex.test(h)) || null
}

const statusCol = computed(() => findCol(props.headers, /status/i))
const loadIdCol = computed(() => findCol(props.headers, /load.?id|job.?id/i))
const detailsCol = computed(() => findCol(props.headers, /details/i))
const originCol = computed(() => (props.headers || []).find(h => /origin|pickup.*(city|info|address)|shipper.*(city|info)/i.test(h) && !/lat|lng|lon/i.test(h)) || null)
const destCol = computed(() => (props.headers || []).find(h => /dest|drop.*(city|info|address)|receiver.*(city|info)|delivery.*(city|info)|consignee.*(city|info)/i.test(h) && !/lat|lng|lon|date|time|appt|eta/i.test(h)) || null)

const status = computed(() => statusCol.value ? (props.load[statusCol.value] || '').trim() : '')
const loadId = computed(() => loadIdCol.value ? props.load[loadIdCol.value] : '')
const isPending = computed(() => /^(assigned|dispatched|)$/i.test(status.value))
const isDispatched = computed(() => /^(dispatched)$/i.test(status.value))
const showResponseButtons = computed(() => isDispatched.value && !props.load._accepted)
const showAcceptedBadge = computed(() => isDispatched.value && props.load._accepted)
const isActiveLoad = computed(() => /^(assigned|dispatched|at shipper|loading|in transit|at receiver|unloading)$/i.test(status.value))

const route = computed(() => {
  if (detailsCol.value) {
    const details = (props.load[detailsCol.value] || '').trim()
    if (details) return details.replace(/\s*-\s*/, ' \u2192 ')
  }
  const o = originCol.value ? props.load[originCol.value] : ''
  const d = destCol.value ? props.load[destCol.value] : ''
  if (o || d) return `${o || '\u2014'} \u2192 ${d || '\u2014'}`
  return ''
})

const pickupFields = computed(() => {
  const exclude = /lat|lng|lon/i
  return props.headers
    .filter(h => /pickup|shipper/i.test(h) && !exclude.test(h))
    .map(h => ({
      header: h,
      label: h.replace(/pickup\s*|shipper\s*/gi, '').trim() || h,
      value: (props.load[h] || '').trim()
    }))
})

const dropoffFields = computed(() => {
  const exclude = /lat|lng|lon/i
  return props.headers
    .filter(h => /drop.?off|deliv|receiver|consignee/i.test(h) && !exclude.test(h))
    .map(h => ({
      header: h,
      label: h.replace(/drop.?off\s*|delivery\s*|deliv\s*|receiver\s*|consignee\s*/gi, '').trim() || h,
      value: (props.load[h] || '').trim()
    }))
})
</script>

<style scoped>
.load-detail {
  padding: 0 0.25rem;
  padding-bottom: 120px;
}

.detail-topbar {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  margin-bottom: 0.75rem;
}

.topbar-title {
  font-size: 0.95rem;
  font-weight: 700;
  font-family: 'JetBrains Mono', monospace;
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.route-banner {
  display: flex;
  align-items: flex-start;
  gap: 0.4rem;
  padding: 0.6rem 0.75rem;
  background: var(--bg);
  border-radius: 8px;
  margin-bottom: 0.75rem;
}

.route-icon {
  font-size: 0.85rem;
  flex-shrink: 0;
}

.route-text {
  font-size: 0.82rem;
  font-weight: 500;
  color: var(--text);
  line-height: 1.35;
}

.detail-collapse {
  margin-bottom: 0.75rem;
  border-radius: var(--radius);
  overflow: hidden;
}

.detail-collapse :deep(.van-collapse-item__content) {
  padding: 0;
}

.detail-collapse :deep(.doc-upload) {
  margin-top: 0;
  background: transparent;
  border: none;
  padding: 0.5rem;
  margin-bottom: 0;
}

.detail-collapse :deep(.card) {
  background: transparent;
  border: none;
  padding: 0;
  margin-bottom: 0;
  box-shadow: none;
}

.cell-value-row {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  justify-content: flex-end;
}
.copy-btn {
  border: none;
  background: none;
  cursor: pointer;
  padding: 0.15rem;
  font-size: 0.85rem;
  line-height: 1;
  opacity: 0.5;
  transition: opacity 0.15s;
  flex-shrink: 0;
}
.copy-btn:hover {
  opacity: 1;
}
.copied-text {
  font-size: 0.65rem;
  font-weight: 600;
  color: #16a34a;
}
.map-icon {
  font-size: 0.85rem;
  line-height: 1;
}

/* Truck Details */
.truck-detail-card { padding: 0.25rem 0; }
.truck-photo {
  width: 100%; max-height: 160px; object-fit: cover;
  border-radius: 8px; margin-bottom: 0.5rem;
}
.truck-status {
  display: inline-flex; padding: 0.1rem 0.5rem; border-radius: 10px;
  font-size: 0.7rem; font-weight: 600;
}
.ts-active { background: rgba(52,211,153,0.15); color: #34d399; }
.ts-inactive { background: rgba(156,163,175,0.15); color: #9ca3af; }
.ts-maintenance { background: rgba(251,191,36,0.15); color: #f59e0b; }
.ts-oos { background: rgba(239,68,68,0.15); color: #ef4444; }

.load-response-actions { display: flex; gap: 0.75rem; padding: 1rem 0.5rem; }
.load-response-actions .van-button { flex: 1; font-weight: 600; height: 44px; border-radius: 10px; }
.load-accepted-banner { text-align: center; padding: 0.75rem; margin: 0.75rem 0; background: #ecfdf5; color: #047857; font-weight: 600; border-radius: 10px; font-size: 0.9rem; }

.expenses-section { padding: 0.5rem; background: var(--bg, #f8f9fa); border-radius: 8px; }
.expense-history { margin-top: 0.75rem; }
.expense-history-label { font-size: 0.72rem; font-weight: 600; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 0.5rem; padding-top: 0.5rem; border-top: 1px solid var(--border, #e5e7eb); }
</style>
