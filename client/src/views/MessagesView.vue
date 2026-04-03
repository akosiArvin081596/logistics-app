<template>
  <div class="messages-page admin-page">
    <div class="page-header">
      <h2>Messages</h2>
      <span v-if="msgStore.totalUnread > 0" class="unread-pill">{{ msgStore.totalUnread }} unread</span>
    </div>
    <div class="messages-fill">
      <MessagingPanel :driver-names="driverNames" />
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, onUnmounted } from 'vue'
import { useDashboardStore } from '../stores/dashboard'
import { useMessagesStore } from '../stores/messages'
import { useSocket } from '../composables/useSocket'
import MessagingPanel from '../components/dashboard/MessagingPanel.vue'

const store = useDashboardStore()
const msgStore = useMessagesStore()
const socket = useSocket()

const driverNames = computed(() =>
  store.fleet.map((f) => f.Driver || '').filter(Boolean)
)

function onNewMessage(msg) {
  msgStore.addIncomingMessage(msg)
}

onMounted(async () => {
  if (store.fleet.length === 0) await store.refresh()
  msgStore.loadConversations()
  socket.connect()
  socket.register('dispatch')
  socket.on('new-message', onNewMessage)
})

onUnmounted(() => {
  socket.off('new-message', onNewMessage)
})
</script>

<style scoped>
.messages-page { overflow: hidden; }
.page-header { display: flex; align-items: center; gap: 0.75rem; }
.unread-pill {
  background: var(--danger-dim);
  color: var(--danger);
  font-size: 0.72rem;
  font-weight: 600;
  padding: 0.2rem 0.6rem;
  border-radius: 10px;
}
.messages-fill {
  flex: 1;
  min-height: 0;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow: hidden;
}

:deep(.msg-layout) {
  display: grid;
  grid-template-columns: 240px 1fr;
  height: 100%;
  overflow: hidden;
}
:deep(.msg-sidebar) {
  border-right: 1px solid var(--border);
  overflow-y: auto;
  background: var(--bg);
}
:deep(.msg-sidebar-header) {
  padding: 0.75rem 1rem;
  font-weight: 600;
  font-size: 0.82rem;
  border-bottom: 1px solid var(--border);
  background: var(--surface);
  display: flex;
  align-items: center;
  justify-content: space-between;
}
:deep(.msg-driver-item) {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.6rem 1rem;
  cursor: pointer;
  border-bottom: 1px solid var(--border);
  font-size: 0.82rem;
  transition: background 0.1s;
}
:deep(.msg-driver-item:hover) { background: var(--surface-hover); }
:deep(.msg-driver-item.active) { background: var(--accent-dim); color: var(--accent); font-weight: 600; }
:deep(.msg-unread) {
  min-width: 18px; height: 18px;
  background: var(--danger);
  color: #fff;
  font-size: 0.6rem;
  font-weight: 700;
  border-radius: 9px;
  display: flex; align-items: center; justify-content: center;
  padding: 0 5px;
}
:deep(.msg-time) {
  font-size: 0.65rem;
  color: var(--text-dim);
  font-family: 'JetBrains Mono', monospace;
}
:deep(.msg-chat) {
  display: flex;
  flex-direction: column;
  background: var(--surface);
}
:deep(.msg-chat-header) {
  padding: 0.75rem 1rem;
  font-weight: 600;
  font-size: 0.85rem;
  border-bottom: 1px solid var(--border);
}
:deep(.msg-chat-messages) {
  flex: 1;
  overflow-y: auto;
  padding: 0.75rem 1rem;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}
:deep(.msg-bubble) {
  max-width: 70%;
  padding: 0.5rem 0.75rem;
  border-radius: 10px;
  font-size: 0.82rem;
  line-height: 1.4;
  word-break: break-word;
}
:deep(.msg-bubble.sent) {
  align-self: flex-end;
  background: var(--accent);
  color: #fff;
  border-bottom-right-radius: 3px;
}
:deep(.msg-bubble.received) {
  align-self: flex-start;
  background: var(--bg);
  border: 1px solid var(--border);
  border-bottom-left-radius: 3px;
}
:deep(.msg-bubble .msg-meta) { font-size: 0.6rem; margin-top: 0.15rem; opacity: 0.7; }
:deep(.msg-bubble .msg-load-tag) {
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.58rem;
  background: rgba(0,0,0,0.08);
  padding: 0.05rem 0.35rem;
  border-radius: 3px;
  margin-bottom: 0.2rem;
  display: inline-block;
}
:deep(.msg-bubble.sent .msg-load-tag) { background: rgba(255,255,255,0.2); }
:deep(.msg-chat-input) {
  display: flex;
  gap: 0.5rem;
  padding: 0.6rem 1rem;
  border-top: 1px solid var(--border);
}
:deep(.msg-input) {
  flex: 1;
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--border);
  border-radius: 18px;
  font-family: inherit;
  font-size: 0.82rem;
  outline: none;
}
:deep(.msg-input:focus) { border-color: var(--accent); }
:deep(.msg-send-btn) {
  width: 36px; height: 36px;
  border-radius: 50%;
  background: var(--accent);
  color: #fff;
  border: none;
  font-size: 0.95rem;
  cursor: pointer;
  display: flex; align-items: center; justify-content: center;
}
:deep(.msg-attach-btn) {
  display: flex; align-items: center; justify-content: center;
  width: 36px; height: 36px; font-size: 1.1rem; cursor: pointer;
  border-radius: 50%; border: 1px solid var(--border); background: var(--bg);
  transition: background 0.15s;
}
:deep(.msg-attach-btn:hover) { background: var(--accent-dim); }
:deep(.msg-attach-preview) {
  display: flex; align-items: center; gap: 0.5rem; padding: 0.4rem 1rem;
  background: #eff6ff; font-size: 0.75rem; color: #1e40af; border-top: 1px solid var(--border);
}
:deep(.msg-attach-remove) {
  background: none; border: none; cursor: pointer; font-size: 1rem; color: #6b7280;
}
</style>
