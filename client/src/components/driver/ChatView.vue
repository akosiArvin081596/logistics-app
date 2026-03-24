<template>
  <div class="chat-container">
    <!-- Load selector -->
    <div class="chat-filter">
      <select
        v-model="selectedLoadId"
        class="load-selector"
        @change="$emit('changeLoad', selectedLoadId)"
      >
        <option value="" disabled>Select a load to chat</option>
        <option
          v-for="id in availableLoadIds"
          :key="id"
          :value="id"
        >Load {{ id }}</option>
      </select>
    </div>

    <!-- Messages -->
    <div ref="chatMessagesEl" class="chat-messages">
      <EmptyState v-if="!selectedLoadId">
        <div class="empty-icon">&#128172;</div>
        Select a load above to view messages.
      </EmptyState>
      <EmptyState v-else-if="filteredMessages.length === 0">
        <div class="empty-icon">&#128172;</div>
        No messages for this load.<br>Send one below.
      </EmptyState>
      <template v-else>
        <div
          v-for="(m, i) in filteredMessages"
          :key="m.id || i"
          :class="['msg-bubble', isSent(m) ? 'sent' : 'received']"
        >
          <div v-if="!isSent(m)" class="msg-sender">{{ m.from }}</div>
          {{ m.message }}
          <div class="msg-meta">{{ formatTime(m.timestamp) }}</div>
        </div>
      </template>
    </div>

    <!-- Input bar -->
    <div v-if="selectedLoadId" class="chat-input-bar">
      <input
        v-model="messageText"
        class="chat-input"
        type="text"
        placeholder="Message Dispatch..."
        maxlength="500"
        @keydown.enter.prevent="handleSend"
      />
      <button
        class="send-btn"
        :disabled="!messageText.trim() || sending"
        @click="handleSend"
      >&#10148;</button>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, nextTick, onMounted } from 'vue'
import EmptyState from '../shared/EmptyState.vue'

const props = defineProps({
  messages: { type: Array, default: () => [] },
  loads: { type: Array, default: () => [] },
  driverName: { type: String, required: true },
  loadId: { type: String, default: '' },
})

const emit = defineEmits(['send', 'markRead', 'changeLoad'])

const chatMessagesEl = ref(null)
const messageText = ref('')
const sending = ref(false)
const selectedLoadId = ref(props.loadId || '')

// Sync when parent changes loadId (e.g. from LoadCard chat button)
watch(() => props.loadId, (val) => {
  if (val) selectedLoadId.value = val
})

// Extract load IDs from the driver's actual loads
const availableLoadIds = computed(() => {
  const ids = []
  for (const load of props.loads) {
    for (const key of Object.keys(load)) {
      if (/load.?id|job.?id/i.test(key) && load[key]) {
        ids.push(String(load[key]))
        break
      }
    }
  }
  return [...new Set(ids)]
})

const filteredMessages = computed(() => {
  if (!selectedLoadId.value) return []
  return props.messages.filter((m) => m.loadId === selectedLoadId.value)
})

function isSent(m) {
  return (m.from || '').toLowerCase() === props.driverName.toLowerCase()
}

function formatTime(str) {
  if (!str) return ''
  const d = new Date(str)
  if (isNaN(d)) return str
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
}

async function handleSend() {
  const msg = messageText.value.trim()
  if (!msg || sending.value || !selectedLoadId.value) return

  sending.value = true
  try {
    emit('send', {
      recipient: 'Dispatch',
      message: msg,
      loadId: selectedLoadId.value,
    })
    messageText.value = ''
  } finally {
    sending.value = false
  }
}

function scrollToBottom() {
  nextTick(() => {
    if (chatMessagesEl.value) {
      chatMessagesEl.value.scrollTop = chatMessagesEl.value.scrollHeight
    }
  })
}

function markUnread() {
  if (!selectedLoadId.value) return
  const unreadIds = filteredMessages.value
    .filter(
      (m) =>
        (m.to || '').toLowerCase() === props.driverName.toLowerCase() &&
        !m.read
    )
    .map((m) => m.id)
    .filter(Boolean)

  if (unreadIds.length > 0) {
    emit('markRead', unreadIds)
  }
}

onMounted(() => {
  scrollToBottom()
  markUnread()
})

watch(
  () => filteredMessages.value.length,
  () => {
    scrollToBottom()
    markUnread()
  }
)
</script>

<style scoped>
.chat-container {
  display: flex;
  flex-direction: column;
  height: calc(100vh - 200px);
}

.chat-filter {
  padding: 0 0 0.75rem;
  display: flex;
  gap: 0.5rem;
}

.load-selector {
  flex: 1;
  padding: 0.6rem 0.75rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  font-family: inherit;
  font-size: 0.85rem;
  background: var(--surface);
  color: var(--text);
  cursor: pointer;
}

.chat-messages {
  flex: 1;
  overflow-y: auto;
  padding: 0.5rem 0;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.msg-bubble {
  max-width: 80%;
  padding: 0.65rem 0.85rem;
  border-radius: 12px;
  font-size: 0.85rem;
  line-height: 1.4;
  word-break: break-word;
}

.msg-bubble.sent {
  align-self: flex-end;
  background: var(--accent);
  color: #fff;
  border-bottom-right-radius: 4px;
}

.msg-bubble.received {
  align-self: flex-start;
  background: var(--surface);
  border: 1px solid var(--border);
  border-bottom-left-radius: 4px;
}

.msg-sender {
  font-weight: 600;
  font-size: 0.75rem;
  margin-bottom: 0.15rem;
}

.msg-meta {
  font-size: 0.65rem;
  color: var(--text-dim);
  margin-top: 0.2rem;
}

.msg-bubble.sent .msg-meta {
  color: rgba(255, 255, 255, 0.7);
}

.chat-input-bar {
  display: flex;
  gap: 0.5rem;
  padding-top: 0.75rem;
  border-top: 1px solid var(--border);
}

.chat-input {
  flex: 1;
  padding: 0.65rem 0.85rem;
  border: 1px solid var(--border);
  border-radius: 20px;
  font-family: inherit;
  font-size: 0.85rem;
  outline: none;
  transition: border-color 0.15s;
}

.chat-input:focus {
  border-color: var(--accent);
}

.send-btn {
  width: 44px;
  height: 44px;
  border-radius: 50%;
  background: var(--accent);
  color: #fff;
  border: none;
  font-size: 1.1rem;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  transition: opacity 0.15s;
}

.send-btn:hover {
  opacity: 0.9;
}

.send-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.empty-icon {
  font-size: 2rem;
  margin-bottom: 0.5rem;
}
</style>
