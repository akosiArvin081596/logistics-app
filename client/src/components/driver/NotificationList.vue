<template>
  <div class="notification-list">
    <div class="notif-header">
      <h2>Notifications</h2>
      <button
        v-if="unreadIds.length"
        class="mark-all-btn"
        @click="$emit('mark-all-read')"
      >Mark all read</button>
    </div>

    <div v-if="!notifications.length" class="notif-empty">
      <span class="notif-empty-icon">&#128276;</span>
      <p>No notifications yet</p>
    </div>

    <div v-else class="notif-items">
      <div
        v-for="n in notifications"
        :key="n.id"
        :class="['notif-item', { unread: !n.read }]"
        @click="$emit('tap', n)"
      >
        <div class="notif-icon-wrap">
          <span class="notif-icon" v-html="typeIcon(n.type)"></span>
          <span v-if="!n.read" class="notif-dot"></span>
        </div>
        <div class="notif-content">
          <div class="notif-title">{{ n.title }}</div>
          <div v-if="n.body" class="notif-body">{{ n.body }}</div>
          <div class="notif-time">{{ formatTime(n.createdAt) }}</div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  notifications: { type: Array, default: () => [] },
})

defineEmits(['tap', 'mark-all-read'])

const unreadIds = computed(() =>
  props.notifications.filter((n) => !n.read).map((n) => n.id)
)

function typeIcon(type) {
  if (type === 'load-assigned') return '&#128666;'
  if (type === 'geofence') return '&#128205;'
  if (type === 'message') return '&#128172;'
  return '&#128276;'
}

function formatTime(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  const now = new Date()
  const diff = now - d
  if (diff < 60000) return 'Just now'
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`
  if (diff < 604800000) return `${Math.floor(diff / 86400000)}d ago`
  return d.toLocaleDateString()
}
</script>

<style scoped>
.notification-list {
  padding: 0 1rem 1rem;
}
.notif-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 1rem 0 0.75rem;
}
.notif-header h2 {
  font-size: 1.1rem;
  font-weight: 700;
}
.mark-all-btn {
  background: none;
  border: none;
  color: var(--accent);
  font-size: 0.78rem;
  font-weight: 600;
  cursor: pointer;
  font-family: inherit;
}
.notif-empty {
  text-align: center;
  padding: 3rem 1rem;
  color: var(--text-dim);
}
.notif-empty-icon {
  font-size: 2.5rem;
  display: block;
  margin-bottom: 0.5rem;
}
.notif-empty p {
  font-size: 0.88rem;
}
.notif-items {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.notif-item {
  display: flex;
  gap: 0.75rem;
  padding: 0.75rem;
  background: var(--surface);
  border-radius: var(--radius);
  border: 1px solid var(--border);
  cursor: pointer;
  transition: background 0.15s;
}
.notif-item:active {
  background: var(--surface-hover);
}
.notif-item.unread {
  background: var(--blue-dim);
  border-color: rgba(59, 130, 246, 0.15);
}
.notif-icon-wrap {
  position: relative;
  flex-shrink: 0;
}
.notif-icon {
  font-size: 1.4rem;
  line-height: 1;
}
.notif-dot {
  position: absolute;
  top: -2px;
  right: -2px;
  width: 8px;
  height: 8px;
  background: var(--blue);
  border-radius: 50%;
}
.notif-content {
  flex: 1;
  min-width: 0;
}
.notif-title {
  font-size: 0.85rem;
  font-weight: 600;
  color: var(--text);
}
.notif-body {
  font-size: 0.78rem;
  color: var(--text-dim);
  margin-top: 0.15rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.notif-time {
  font-size: 0.7rem;
  color: var(--text-dim);
  margin-top: 0.3rem;
}
</style>
