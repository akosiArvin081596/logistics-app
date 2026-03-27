<template>
  <div class="chat-container">
    <!-- Current load indicator -->
    <div v-if="currentLoadId" class="chat-load-banner">
      Current Load: <strong>{{ currentLoadId }}</strong>
    </div>

    <!-- Messages -->
    <div ref="chatMessagesEl" class="chat-messages">
      <EmptyState v-if="props.messages.length === 0">
        <div class="empty-icon">&#128172;</div>
        No messages yet.<br>Send one below to contact Dispatch.
      </EmptyState>
      <template v-else>
        <div
          v-for="(m, i) in props.messages"
          :key="m.id || i"
          :class="['msg-bubble', isSent(m) ? 'sent' : 'received']"
        >
          <div v-if="!isSent(m)" class="msg-sender">{{ m.from }}</div>
          {{ m.message }}
          <div class="msg-footer">
            <span v-if="m.loadId" class="msg-load">{{ m.loadId }}</span>
            <span class="msg-time">{{ formatTime(m.timestamp) }}</span>
          </div>
        </div>
      </template>
    </div>

    <!-- Input bar (always visible) -->
    <div class="chat-input-bar">
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

const emit = defineEmits(['send', 'markRead'])

const chatMessagesEl = ref(null)
const messageText = ref('')
const sending = ref(false)

// Auto-detect current active load ID
const currentLoadId = computed(() => {
  if (props.loadId) return props.loadId
  // Find first working load
  for (const load of props.loads) {
    for (const key of Object.keys(load)) {
      if (/load.?id|job.?id/i.test(key) && load[key]) {
        const statusKey = Object.keys(load).find(k => /^status$/i.test(k))
        const status = statusKey ? (load[statusKey] || '').trim().toLowerCase() : ''
        if (/at shipper|loading|in transit|at receiver/i.test(status)) {
          return String(load[key])
        }
      }
    }
  }
  return ''
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
  if (!msg || sending.value) return

  sending.value = true
  try {
    emit('send', {
      recipient: 'Dispatch',
      message: msg,
      loadId: currentLoadId.value,
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
  const unreadIds = props.messages
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
  () => props.messages.length,
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

.chat-load-banner {
  padding: 0.45rem 0.75rem;
  background: var(--accent-dim, #e0e7ff);
  color: var(--accent, #6366f1);
  font-size: 0.75rem;
  border-radius: var(--radius);
  margin-bottom: 0.5rem;
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

.msg-footer {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  margin-top: 0.2rem;
}

.msg-time {
  font-size: 0.65rem;
  color: var(--text-dim);
}

.msg-bubble.sent .msg-time {
  color: rgba(255, 255, 255, 0.7);
}

.msg-load {
  font-size: 0.6rem;
  font-family: 'JetBrains Mono', monospace;
  font-weight: 600;
  color: var(--text-dim);
  background: var(--bg);
  padding: 0.05rem 0.3rem;
  border-radius: 3px;
}

.msg-bubble.sent .msg-load {
  color: rgba(255, 255, 255, 0.8);
  background: rgba(255, 255, 255, 0.15);
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
