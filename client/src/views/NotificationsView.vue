<template>
  <div class="notifications-page admin-page">
    <div class="page-header">
      <h2>Notifications</h2>
      <button
        v-if="store.unreadCount > 0"
        class="btn btn-secondary btn-sm"
        @click="store.markAllRead()"
      >Mark all read</button>
    </div>
    <div class="notif-container">
      <div v-if="store.notifications.length === 0" class="notif-empty">
        No notifications yet.
      </div>
      <div
        v-for="n in store.notifications"
        :key="n.id"
        :class="['notif-item', { unread: !n.read }]"
        @click="handleTap(n)"
      >
        <div class="notif-icon" v-html="iconFor(n.type)"></div>
        <div class="notif-content">
          <div class="notif-title">{{ n.title }}</div>
          <div class="notif-body" v-if="n.body">{{ n.body }}</div>
          <div class="notif-time">{{ formatNotificationTime(n.createdAt) }}</div>
        </div>
        <span v-if="!n.read" class="notif-dot"></span>
      </div>
    </div>
  </div>
</template>

<script setup>
import { onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { useDispatchNotificationsStore } from '../stores/dispatchNotifications'
import { useSocket } from '../composables/useSocket'

const store = useDispatchNotificationsStore()
const socket = useSocket()
const router = useRouter()

function iconFor(type) {
  if (type === 'status-updated') return '&#128260;'
  if (type === 'pod-uploaded') return '&#128196;'
  if (type === 'geofence') return '&#128205;'
  return '&#128276;'
}

// Absolute timestamp — "04/15/2026 10:30PM" — per 2026-04-21 client request.
// Exact times are more useful than "2h ago" for operational logs (POD hits,
// driver arrivals, cancellations). Input is ISO-UTC from the server; JS
// converts to the viewer's local timezone automatically.
function formatNotificationTime(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  if (isNaN(d.getTime())) return ''
  const pad = (n) => String(n).padStart(2, '0')
  const mm = pad(d.getMonth() + 1)
  const dd = pad(d.getDate())
  const yyyy = d.getFullYear()
  let h = d.getHours()
  const m = pad(d.getMinutes())
  const ampm = h >= 12 ? 'PM' : 'AM'
  h = h % 12 || 12
  return `${mm}/${dd}/${yyyy} ${h}:${m}${ampm}`
}

function handleTap(n) {
  if (!n.read) {
    store.markRead([n.id])
  }
  // Route to /dashboard?load=<id> when the notification carries one.
  // Every server emitter today puts loadId in metadata — see server.js
  // dispatch notification insertions. DashboardView opens the matching
  // load's detail modal automatically.
  let loadId = ''
  try {
    const meta = typeof n.metadata === 'string' ? JSON.parse(n.metadata || '{}') : (n.metadata || {})
    loadId = meta.loadId || meta.load_id || ''
  } catch { /* ignore unparseable metadata */ }
  if (loadId) {
    router.push({ path: '/dashboard', query: { load: loadId } })
  }
}

function onSocketNotification(payload) {
  store.addRealtime({
    id: Date.now(),
    type: payload.type || 'info',
    title: payload.title || '',
    body: payload.body || '',
    metadata: JSON.stringify(payload),
    read: 0,
    createdAt: new Date().toISOString(),
  })
}

onMounted(() => {
  store.fetch()
  socket.connect()
  socket.register('dispatch')
  socket.on('dispatch-notification', onSocketNotification)
})

onUnmounted(() => {
  socket.off('dispatch-notification', onSocketNotification)
})
</script>

<style scoped>
.notif-container {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow: hidden;
}
.notif-empty {
  text-align: center;
  color: var(--text-dim);
  font-size: 0.88rem;
  padding: 3rem 1rem;
}
.notif-item {
  display: flex;
  align-items: flex-start;
  gap: 0.75rem;
  padding: 0.85rem 1rem;
  border-bottom: 1px solid var(--border);
  cursor: pointer;
  transition: background 0.12s;
}
.notif-item:last-child { border-bottom: none; }
.notif-item:hover { background: var(--surface-hover); }
.notif-item.unread { background: rgba(99, 102, 241, 0.04); }
.notif-icon {
  font-size: 1.1rem;
  flex-shrink: 0;
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg);
  border-radius: 8px;
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
  margin-top: 0.1rem;
}
.notif-time {
  font-size: 0.68rem;
  color: var(--text-dim);
  margin-top: 0.25rem;
  font-family: 'JetBrains Mono', monospace;
}
.notif-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--accent);
  flex-shrink: 0;
  margin-top: 0.35rem;
}
</style>
