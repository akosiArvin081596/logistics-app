<template>
  <div class="load-detail">
    <!-- Top bar with back button -->
    <div class="detail-topbar">
      <button class="back-btn" @click="$emit('back')">&#8592; Back</button>
      <span class="topbar-title">{{ loadId || 'Load Details' }}</span>
      <StatusBadge :status="status" />
    </div>

    <!-- Route summary -->
    <div v-if="route" class="route-banner">
      <span class="route-icon">&#128205;</span>
      <span class="route-text">{{ route }}</span>
    </div>

    <!-- Route Map -->
    <div class="accordion-card" style="margin-bottom: 0.75rem;">
      <div class="accordion-item">
        <button class="accordion-header" @click="toggle('map')">
          <span class="accordion-title">Route Map</span>
          <span class="accordion-chevron" :class="{ open: openSections.has('map') }">&#9662;</span>
        </button>
        <div v-show="openSections.has('map')" class="accordion-body">
          <DriverRouteMap
            :load="load"
            :headers="headers"
            :driver-position="driverPosition"
          />
        </div>
      </div>
    </div>

    <!-- Accordion sections -->
    <div class="accordion-card">
      <!-- Pickup Details -->
      <div class="accordion-item">
        <button class="accordion-header" @click="toggle('pickup')">
          <span class="accordion-title">Pickup Details</span>
          <span class="accordion-chevron" :class="{ open: openSections.has('pickup') }">&#9662;</span>
        </button>
        <div v-show="openSections.has('pickup')" class="accordion-body">
          <template v-if="pickupFields.length">
            <div v-for="f in pickupFields" :key="f.header" class="field-row">
              <div class="field-label">{{ f.label }}</div>
              <div class="field-value">{{ f.value || '\u2014' }}</div>
            </div>
          </template>
          <div v-else class="field-empty">No pickup details available</div>
        </div>
      </div>

      <!-- Drop-off Details -->
      <div class="accordion-item">
        <button class="accordion-header" @click="toggle('dropoff')">
          <span class="accordion-title">Drop-off Details</span>
          <span class="accordion-chevron" :class="{ open: openSections.has('dropoff') }">&#9662;</span>
        </button>
        <div v-show="openSections.has('dropoff')" class="accordion-body">
          <template v-if="dropoffFields.length">
            <div v-for="f in dropoffFields" :key="f.header" class="field-row">
              <div class="field-label">{{ f.label }}</div>
              <div class="field-value">{{ f.value || '\u2014' }}</div>
            </div>
          </template>
          <div v-else class="field-empty">No drop-off details available</div>
        </div>
      </div>

      <!-- Documents -->
      <div class="accordion-item">
        <button class="accordion-header" @click="toggle('documents')">
          <span class="accordion-title">Documents</span>
          <span class="accordion-chevron" :class="{ open: openSections.has('documents') }">&#9662;</span>
        </button>
        <div v-show="openSections.has('documents')" class="accordion-body">
          <DocumentUpload
            :load-id="loadId"
            :driver-name="driverName"
            :row-index="load._rowIndex"
            @uploaded="onDocUploaded"
          />
          <DocumentList ref="docListRef" :load-id="loadId" />
        </div>
      </div>

      <!-- Status Update -->
      <div class="accordion-item">
        <button class="accordion-header" @click="toggle('status')">
          <span class="accordion-title">Status Update</span>
          <span class="accordion-chevron" :class="{ open: openSections.has('status') }">&#9662;</span>
        </button>
        <div v-show="openSections.has('status')" class="accordion-body accordion-body--status">
          <StatusStepper
            :load="load"
            :headers="headers"
            :current-status="status"
            :driver-name="driverName"
            :blocked="hasActiveJob && isPending"
            @update="$emit('status-update', $event)"
          />
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, ref } from 'vue'
import StatusBadge from '../shared/StatusBadge.vue'
import StatusStepper from './StatusStepper.vue'
import DocumentUpload from './DocumentUpload.vue'
import DocumentList from './DocumentList.vue'
import DriverRouteMap from './DriverRouteMap.vue'

const props = defineProps({
  load: { type: Object, required: true },
  headers: { type: Array, default: () => [] },
  driverName: { type: String, default: '' },
  hasActiveJob: { type: Boolean, default: false },
  driverPosition: { type: Object, default: null },
})

const emit = defineEmits(['back', 'status-update', 'uploaded'])

const openSections = ref(new Set())
const docListRef = ref(null)

function onDocUploaded() {
  if (docListRef.value) docListRef.value.refresh()
  emit('uploaded')
}

function toggle(section) {
  if (openSections.value.has(section)) {
    openSections.value.delete(section)
  } else {
    openSections.value.add(section)
  }
  // trigger reactivity
  openSections.value = new Set(openSections.value)
}

function findCol(headers, regex) {
  return (headers || []).find((h) => regex.test(h)) || null
}

const statusCol = computed(() => findCol(props.headers, /status/i))
const loadIdCol = computed(() => findCol(props.headers, /load.?id|job.?id/i))
const detailsCol = computed(() => findCol(props.headers, /details/i))
const originCol = computed(() => findCol(props.headers, /origin|pickup.*city|shipper.*city/i))
const destCol = computed(() => findCol(props.headers, /dest|drop.*city|receiver.*city|delivery.*city|consignee.*city/i))

const status = computed(() => statusCol.value ? (props.load[statusCol.value] || '').trim() : '')
const loadId = computed(() => loadIdCol.value ? props.load[loadIdCol.value] : '')
const isPending = computed(() => /^(assigned|dispatched|)$/i.test(status.value))

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

// Pickup detail fields
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

// Drop-off detail fields
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
  padding: 0 0.5rem;
}

/* Top bar */
.detail-topbar {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  margin-bottom: 0.75rem;
}

.back-btn {
  padding: 0.4rem 0.6rem;
  font-size: 0.8rem;
  font-family: inherit;
  font-weight: 600;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface);
  color: var(--text);
  cursor: pointer;
  transition: background 0.15s;
  flex-shrink: 0;
}

.back-btn:active {
  background: var(--bg);
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

/* Route banner */
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

/* Accordion card */
.accordion-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow: hidden;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.06);
}

.accordion-item {
  border-bottom: 1px solid var(--border);
}

.accordion-item:last-child {
  border-bottom: none;
}

.accordion-header {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.85rem 1rem;
  background: none;
  border: none;
  font-family: inherit;
  font-size: 0.88rem;
  font-weight: 600;
  color: var(--text);
  cursor: pointer;
  transition: background 0.15s;
}

.accordion-header:active {
  background: var(--bg);
}

.accordion-chevron {
  font-size: 0.75rem;
  color: var(--text-dim);
  transition: transform 0.2s;
  display: inline-block;
}

.accordion-chevron.open {
  transform: rotate(180deg);
}

.accordion-body {
  padding: 0 1rem 0.85rem;
}

/* Override global .card for embedded components */
.accordion-body :deep(.doc-upload) {
  margin-top: 0;
  background: transparent;
  border: none;
  padding: 0;
  margin-bottom: 0;
}

.accordion-body--status :deep(.card) {
  background: transparent;
  border: none;
  padding: 0;
  margin-bottom: 0;
  box-shadow: none;
}

/* Detail field rows */
.field-row {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  padding: 0.5rem 0;
  border-bottom: 1px solid var(--bg);
  gap: 0.75rem;
}

.field-row:last-child {
  border-bottom: none;
}

.field-label {
  font-size: 0.78rem;
  font-weight: 500;
  color: var(--text-dim);
  flex-shrink: 0;
  min-width: 80px;
}

.field-value {
  font-size: 0.82rem;
  font-weight: 500;
  color: var(--text);
  text-align: right;
  word-break: break-word;
}

.field-empty {
  text-align: center;
  color: var(--text-dim);
  font-size: 0.8rem;
  padding: 0.5rem 0;
}
</style>
