<template>
  <!-- A driver's own time off (R11 follow-up), read-only. variant "card" is the
       Kit tab's "My time off"; variant "banner" is the one line at the top of
       the Loads list while he is off and in the 7 days before. Rows go through
       driverTimeOffRows(), which keeps his current and upcoming rows and, of
       each, only the dates, the kind and whether he is off now. DriverView
       renders this only when the payload carried `timeOff` (the server's
       DRIVER_TIME_OFF_SCREEN_ENABLED). -->
  <div v-if="variant === 'banner'" role="status" class="time-off-live">
    <p v-if="bannerText" :class="['time-off-banner', offNow ? 'time-off-banner-now' : 'time-off-banner-next']">
      <span class="time-off-banner-icon" aria-hidden="true">&#128197;</span>
      <span class="time-off-banner-text">{{ bannerText }}</span>
    </p>
  </div>

  <section v-else class="card time-off-card" :aria-labelledby="titleId">
    <div class="time-off-header">
      <div class="time-off-icon" aria-hidden="true">&#128197;</div>
      <h3 :id="titleId" class="time-off-title">My time off</h3>
    </div>

    <p v-if="loadFailed" class="time-off-empty">Your time off couldn't be loaded. Try again later.</p>
    <ul v-else-if="rows.length" class="time-off-list">
      <li v-for="r in rows" :key="r.id" class="time-off-row">
        <span class="time-off-range">{{ availabilityRangeText(r.from, r.to) }}</span>
        <span class="time-off-meta">
          <span class="time-off-kind">{{ kindLabel(r.kind) }}</span>
          <span :class="['time-off-tag', r.status === 'current' ? 'time-off-tag-now' : 'time-off-tag-next']">{{ r.status === 'current' ? 'Off now' : 'Upcoming' }}</span>
        </span>
      </li>
    </ul>
    <p v-else class="time-off-empty">No time off recorded.</p>

    <p class="time-off-hint">Dispatch records your time off. To change it, message dispatch.</p>
    <button type="button" class="time-off-btn" @click="emit('message-dispatch')">Message dispatch</button>
  </section>
</template>

<script setup>
import { computed, useId } from 'vue'
import { availabilityRangeText, driverTimeOffBanner, driverTimeOffRows, kindLabel } from '../../lib/availabilityText'

const props = defineProps({
  // The payload's `timeOff`: { today, rows }, or { today, rows: [], error: true }
  // when the server could not read it.
  timeOff: { type: Object, required: true },
  variant: { type: String, default: 'card' },
})
const emit = defineEmits(['message-dispatch'])

const titleId = useId()
const loadFailed = computed(() => props.timeOff.error === true)
const rows = computed(() => driverTimeOffRows(props.timeOff.rows))
const bannerText = computed(() => driverTimeOffBanner(rows.value, props.timeOff.today))
const offNow = computed(() => rows.value.some((r) => r.from <= props.timeOff.today && props.timeOff.today <= r.to))
</script>

<style scoped>
.time-off-card {
  margin-top: 1rem;
}
.time-off-header {
  display: flex;
  align-items: center;
  gap: 0.65rem;
  margin-bottom: 0.75rem;
}
.time-off-icon {
  width: 32px;
  height: 32px;
  border-radius: 8px;
  background: var(--accent-dim);
  color: var(--accent);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 1rem;
  flex-shrink: 0;
}
.time-off-title {
  font-size: 0.95rem;
  font-weight: 700;
  margin: 0;
}
.time-off-list {
  list-style: none;
  margin: 0 0 0.75rem;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.time-off-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 0.35rem 0.75rem;
  padding: 0.7rem 0.85rem;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 10px;
  min-width: 0;
}
.time-off-range {
  font-size: 0.9rem;
  font-weight: 600;
  color: var(--text);
  overflow-wrap: anywhere;
}
.time-off-meta {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
}
.time-off-kind {
  font-size: 0.8rem;
  color: var(--text-dim);
}
.time-off-tag {
  font-size: 0.68rem;
  font-weight: 700;
  padding: 0.15rem 0.55rem;
  border-radius: 12px;
  white-space: nowrap;
}
.time-off-tag-now {
  background: var(--amber-dim);
  color: #92400e;
}
.time-off-tag-next {
  background: var(--accent-dim);
  color: #0369a1;
}
.time-off-empty {
  font-size: 0.85rem;
  color: var(--text-dim);
  margin: 0 0 0.75rem;
}
.time-off-hint {
  font-size: 0.8rem;
  color: var(--text-dim);
  margin: 0 0 0.6rem;
}
.time-off-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  min-height: 44px;
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--accent);
  border-radius: var(--radius, 8px);
  background: transparent;
  color: #0369a1;
  font-family: inherit;
  font-size: 0.85rem;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.15s;
}
.time-off-btn:hover {
  background: var(--accent-dim);
}
.time-off-btn:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.time-off-banner {
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
  margin: 0 0 0.75rem;
  padding: 0.6rem 0.8rem;
  border-radius: var(--radius, 8px);
  font-size: 0.85rem;
  font-weight: 600;
  line-height: 1.35;
  overflow-wrap: anywhere;
}
.time-off-banner-now {
  background: var(--amber-dim);
  border: 1px solid rgba(245, 158, 11, 0.35);
  color: #92400e;
}
.time-off-banner-next {
  background: var(--accent-dim);
  border: 1px solid rgba(56, 189, 248, 0.35);
  color: #0369a1;
}
.time-off-banner-icon {
  flex-shrink: 0;
}
.time-off-banner-text {
  min-width: 0;
}
@media (min-width: 768px) {
  .time-off-btn {
    width: auto;
    padding: 0.5rem 1.25rem;
  }
}
</style>
