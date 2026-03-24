<template>
  <div class="msg-layout">
    <!-- Sidebar: conversations grouped by driver + load -->
    <div class="msg-sidebar" style="position:relative;">
      <div class="msg-sidebar-header">
        Conversations
        <button class="new-msg-btn" @click="showNewMsg = !showNewMsg" :title="showNewMsg ? 'Cancel' : 'New message'">
          {{ showNewMsg ? '&times;' : '+' }}
        </button>
      </div>
      <div v-if="showNewMsg" class="new-msg-form">
        <select v-model="newDriver" class="new-msg-select" @change="newLoadId = ''">
          <option value="" disabled>Select driver</option>
          <option v-for="d in props.driverNames" :key="d" :value="d">{{ d }}</option>
        </select>
        <select v-model="newLoadId" class="new-msg-select" :disabled="!newDriver || loadsForDriver.length === 0">
          <option value="" disabled>{{ !newDriver ? 'Pick driver first' : loadsForDriver.length === 0 ? 'No active loads' : 'Select load' }}</option>
          <option v-for="id in loadsForDriver" :key="id" :value="id">Load {{ id }}</option>
        </select>
        <button class="new-msg-start" :disabled="!newDriver || !newLoadId" @click="startConversation">Open Chat</button>
      </div>
      <div class="msg-driver-list">
        <div
          v-for="c in store.conversations"
          :key="c.driver + ':' + c.loadId"
          :class="['msg-driver-item', { active: isActive(c) }]"
          @click="selectConversation(c)"
        >
          <div>
            <div>{{ c.driver }}</div>
            <div v-if="c.loadId" class="msg-load-label">Load {{ c.loadId }}</div>
            <div v-else class="msg-load-label">Legacy</div>
            <div class="msg-time">{{ formatTime(c.lastTimestamp) }}</div>
          </div>
          <div v-if="c.unread > 0" class="msg-unread">{{ c.unread }}</div>
        </div>
        <EmptyState v-if="store.conversations.length === 0">No conversations yet.</EmptyState>
      </div>
    </div>

    <!-- Chat area -->
    <div class="msg-chat">
      <div class="msg-chat-header">
        <template v-if="store.selectedDriver">
          {{ store.selectedDriver }}
          <span v-if="store.selectedLoadId" class="msg-header-load">— Load {{ store.selectedLoadId }}</span>
        </template>
        <template v-else>Select a conversation</template>
      </div>
      <div ref="messagesEl" class="msg-chat-messages">
        <template v-if="store.selectedDriver && store.currentMessages.length > 0">
          <ChatBubble v-for="(m, i) in store.currentMessages" :key="i" :msg="m" />
        </template>
        <EmptyState v-else-if="store.selectedDriver">No messages yet.</EmptyState>
        <EmptyState v-else>Select a conversation from the left to view messages.</EmptyState>
      </div>
      <div v-if="store.selectedDriver && store.selectedLoadId" class="msg-chat-input">
        <input
          v-model="messageInput"
          type="text"
          class="msg-input"
          placeholder="Reply to driver..."
          maxlength="500"
          @keydown.enter.prevent="sendMessage"
        />
        <button class="msg-send-btn" @click="sendMessage">&#10148;</button>
      </div>
      <div v-else-if="store.selectedDriver && !store.selectedLoadId" class="msg-chat-legacy">
        Legacy conversation — replies require a load context.
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, nextTick } from 'vue'
import { useMessagesStore } from '../../stores/messages'
import { useDashboardStore } from '../../stores/dashboard'
import { useToast } from '../../composables/useToast'
import ChatBubble from './ChatBubble.vue'
import EmptyState from '../shared/EmptyState.vue'

const props = defineProps({
  driverNames: { type: Array, default: () => [] },
})

const store = useMessagesStore()
const dashStore = useDashboardStore()
const { show: toast } = useToast()

const messageInput = ref('')
const messagesEl = ref(null)

// New conversation form state
const showNewMsg = ref(false)
const newDriver = ref('')
const newLoadId = ref('')

const loadsForDriver = computed(() => {
  if (!newDriver.value) return []
  const name = newDriver.value.toLowerCase()
  const ids = new Set()
  for (const job of dashStore.activeJobs) {
    const driverKey = Object.keys(job).find((k) => /^driver$/i.test(k))
    if (driverKey && (job[driverKey] || '').toLowerCase() === name) {
      const loadKey = Object.keys(job).find((k) => /load.?id|job.?id/i.test(k))
      if (loadKey && job[loadKey]) ids.add(String(job[loadKey]))
    }
  }
  return [...ids]
})

function startConversation() {
  if (!newDriver.value || !newLoadId.value) return
  store.selectConversation(newDriver.value, newLoadId.value)
  showNewMsg.value = false
  newDriver.value = ''
  newLoadId.value = ''
}

function isActive(c) {
  return store.selectedDriver &&
    c.driver.toLowerCase() === store.selectedDriver.toLowerCase() &&
    c.loadId === store.selectedLoadId
}

function selectConversation(c) {
  store.selectConversation(c.driver, c.loadId || '')
}

function formatTime(ts) {
  const t = new Date(ts)
  return isNaN(t) ? '' : t.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
}

async function sendMessage() {
  const msg = messageInput.value.trim()
  if (!msg || !store.selectedDriver || !store.selectedLoadId) return
  try {
    await store.sendMessage(store.selectedDriver, msg, store.selectedLoadId)
    messageInput.value = ''
    scrollToBottom()
  } catch {
    toast('Failed to send', 'error')
  }
}

function scrollToBottom() {
  nextTick(() => {
    if (messagesEl.value) messagesEl.value.scrollTop = messagesEl.value.scrollHeight
  })
}

watch(() => store.currentMessages.length, scrollToBottom)
</script>

<style scoped>
.msg-sidebar-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.new-msg-btn {
  width: 26px;
  height: 26px;
  border-radius: 50%;
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--text);
  font-size: 1.1rem;
  line-height: 1;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
}

.new-msg-btn:hover {
  background: var(--accent);
  color: #fff;
  border-color: var(--accent);
}

.new-msg-form {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  padding: 0.5rem 0.6rem;
  border-bottom: 1px solid var(--border);
}

.new-msg-select {
  padding: 0.4rem 0.5rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  font-family: inherit;
  font-size: 0.78rem;
  background: var(--surface);
  color: var(--text);
  cursor: pointer;
}

.new-msg-start {
  padding: 0.4rem;
  border: none;
  border-radius: var(--radius);
  background: var(--accent);
  color: #fff;
  font-family: inherit;
  font-size: 0.78rem;
  cursor: pointer;
}

.new-msg-start:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.msg-load-label {
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.68rem;
  color: var(--text-dim);
}

.msg-header-load {
  font-weight: 400;
  font-size: 0.8rem;
  color: var(--text-dim);
}

.msg-chat-legacy {
  padding: 0.75rem 1rem;
  font-size: 0.82rem;
  color: var(--text-dim);
  text-align: center;
  border-top: 1px solid var(--border);
}
</style>
