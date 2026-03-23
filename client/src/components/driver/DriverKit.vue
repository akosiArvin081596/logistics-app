<template>
  <div v-if="!driverInfo" class="empty-state">
    <div class="empty-icon">&#128196;</div>
    No driver profile found.
  </div>
  <div v-else class="card">
    <div class="kit-header">
      <div class="kit-avatar">{{ initials(displayName) }}</div>
      <div>
        <div class="kit-name">{{ displayName }}</div>
        <div class="kit-role">Driver</div>
      </div>
    </div>
    <div
      v-for="row in visibleRows"
      :key="row.key"
      class="card-row"
    >
      <span class="card-label">{{ row.key }}</span>
      <span class="card-value">
        <a
          v-if="isUrl(row.value)"
          :href="row.value"
          target="_blank"
          rel="noopener"
          class="kit-link"
        >{{ row.value }}</a>
        <template v-else>{{ row.value }}</template>
      </span>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  driverInfo: { type: Object, default: null },
  headers: { type: Array, default: () => [] },
})

function findCol(headers, regex) {
  return (headers || []).find((h) => regex.test(h)) || null
}

const driverCol = computed(() => findCol(props.headers, /driver/i) || props.headers[0])

const displayName = computed(() => {
  if (!props.driverInfo) return ''
  return props.driverInfo[driverCol.value] || ''
})

const visibleRows = computed(() => {
  if (!props.driverInfo) return []
  return props.headers
    .filter((h) => h !== '_rowIndex' && props.driverInfo[h])
    .map((h) => ({ key: h, value: props.driverInfo[h] }))
})

function initials(name) {
  return (name || '?')
    .split(/\s+/)
    .map((w) => w[0])
    .join('')
    .toUpperCase()
    .slice(0, 2)
}

function isUrl(val) {
  return /^https?:\/\//i.test(val || '')
}
</script>

<style scoped>
.kit-header {
  display: flex;
  align-items: center;
  gap: 1rem;
  margin-bottom: 1rem;
}

.kit-avatar {
  width: 56px;
  height: 56px;
  border-radius: 50%;
  background: var(--accent-dim);
  color: var(--accent);
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 700;
  font-size: 1.2rem;
  flex-shrink: 0;
}

.kit-name {
  font-size: 1.1rem;
  font-weight: 700;
}

.kit-role {
  font-size: 0.78rem;
  color: var(--text-dim);
}

.card-row {
  display: flex;
  justify-content: space-between;
  padding: 0.35rem 0;
  font-size: 0.85rem;
  border-bottom: 1px solid var(--bg);
}

.card-row:last-child {
  border-bottom: none;
}

.card-label {
  color: var(--text-dim);
}

.card-value {
  font-weight: 500;
  text-align: right;
  max-width: 60%;
  word-break: break-word;
}

.kit-link {
  color: var(--accent);
  word-break: break-all;
}

.empty-icon {
  font-size: 2rem;
  margin-bottom: 0.5rem;
}
</style>
