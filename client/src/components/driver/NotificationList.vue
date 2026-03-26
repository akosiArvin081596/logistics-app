<template>
  <div class="notification-list">
    <div class="notif-header">
      <h2>Notifications</h2>
      <van-button
        v-if="unreadIds.length"
        type="primary"
        plain
        size="mini"
        @click="$emit('mark-all-read')"
      >Mark all read</van-button>
    </div>

    <van-empty v-if="!notifications.length" description="No notifications yet" image="default" />

    <van-cell-group v-else :border="false" class="notif-group">
      <van-cell
        v-for="n in notifications"
        :key="n.id"
        :class="{ unread: !n.read }"
        clickable
        @click="$emit('tap', n)"
      >
        <template #icon>
          <van-badge :dot="!n.read">
            <span class="notif-icon" v-html="typeIcon(n.type)"></span>
          </van-badge>
        </template>
        <template #title>
          <span class="notif-title">{{ n.title }}</span>
        </template>
        <template #label>
          <span v-if="n.body" class="notif-body">{{ n.body }}</span>
          <span class="notif-time">{{ formatTime(n.createdAt) }}</span>
        </template>
      </van-cell>
    </van-cell-group>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { Cell as VanCell, CellGroup as VanCellGroup, Badge as VanBadge, Button as VanButton, Empty as VanEmpty } from 'vant'

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
  padding: 0 0.5rem;
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
.notif-group {
  border-radius: var(--radius);
  overflow: hidden;
}
.notif-icon {
  font-size: 1.3rem;
  margin-right: 0.5rem;
}
.notif-title {
  font-size: 0.85rem;
  font-weight: 600;
}
.notif-body {
  display: block;
  font-size: 0.78rem;
  color: var(--text-dim);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.notif-time {
  display: block;
  font-size: 0.7rem;
  color: var(--text-dim);
  margin-top: 0.15rem;
}
.unread {
  background: var(--blue-dim) !important;
}
</style>
