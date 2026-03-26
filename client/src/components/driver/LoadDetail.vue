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
          :load="load"
          :headers="headers"
          :driver-position="driverPosition"
        />
      </van-collapse-item>
    </van-collapse>

    <!-- Main accordion sections -->
    <van-collapse v-model="openSections" class="detail-collapse" :border="false">
      <van-collapse-item title="Pickup Details" name="pickup">
        <template v-if="pickupFields.length">
          <van-cell
            v-for="f in pickupFields"
            :key="f.header"
            :title="f.label"
            :value="f.value || '\u2014'"
            :border="true"
          />
        </template>
        <van-empty v-else description="No pickup details available" image="search" :image-size="60" />
      </van-collapse-item>

      <van-collapse-item title="Drop-off Details" name="dropoff">
        <template v-if="dropoffFields.length">
          <van-cell
            v-for="f in dropoffFields"
            :key="f.header"
            :title="f.label"
            :value="f.value || '\u2014'"
            :border="true"
          />
        </template>
        <van-empty v-else description="No drop-off details available" image="search" :image-size="60" />
      </van-collapse-item>

      <van-collapse-item title="Documents" name="documents">
        <DocumentUpload
          :load-id="loadId"
          :driver-name="driverName"
          :row-index="load._rowIndex"
          @uploaded="onDocUploaded"
        />
        <DocumentList ref="docListRef" :load-id="loadId" />
      </van-collapse-item>

      <van-collapse-item title="Status Update" name="status">
        <StatusStepper
          :load="load"
          :headers="headers"
          :current-status="status"
          :driver-name="driverName"
          :blocked="hasActiveJob && isPending"
          @update="$emit('status-update', $event)"
        />
      </van-collapse-item>
    </van-collapse>
  </div>
</template>

<script setup>
import { computed, ref } from 'vue'
import { Collapse as VanCollapse, CollapseItem as VanCollapseItem, Cell as VanCell, Button as VanButton, Empty as VanEmpty } from 'vant'
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

const openSections = ref(['map'])
const docListRef = ref(null)

function onDocUploaded() {
  if (docListRef.value) docListRef.value.refresh()
  emit('uploaded')
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
</style>
