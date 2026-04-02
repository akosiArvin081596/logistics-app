<template>
  <div class="section chat-section">
    <div class="section-title">
      <div class="section-icon" style="background: var(--accent-dim); color: var(--accent);">&#128172;</div>
      Messages
      <span v-if="unread > 0" class="unread-badge">{{ unread }}</span>
    </div>

    <!-- Message thread -->
    <div class="chat-body" ref="chatBody">
      <div v-if="messages.length === 0" class="chat-empty">
        No messages yet. Send a message to get in touch with dispatch.
      </div>
      <div
        v-for="msg in messages"
        :key="msg.id"
        :class="['bubble-row', isMine(msg) ? 'mine' : 'theirs']"
      >
        <div class="bubble">
          <div class="bubble-meta">
            <span class="bubble-from">{{ isMine(msg) ? 'You' : 'Dispatch' }}</span>
            <span class="bubble-time">{{ fmtTime(msg.timestamp) }}</span>
          </div>
          <div class="bubble-text">{{ msg.message }}</div>
        </div>
      </div>
    </div>

    <!-- Composer -->
    <div class="chat-composer">
      <textarea
        v-model="draft"
        class="chat-input"
        placeholder="Type a message..."
        rows="2"
        @keydown.enter.exact.prevent="send"
      ></textarea>
      <button class="send-btn" :disabled="!draft.trim() || sending" @click="send">
        {{ sending ? '...' : 'Send' }}
      </button>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted, nextTick } from 'vue'
import { useApi } from '../../composables/useApi'
import { useSocket } from '../../composables/useSocket'
import { useAuthStore } from '../../stores/auth'

const api = useApi()
const socket = useSocket()
const auth = useAuthStore()

const messages = ref([])
const draft = ref('')
const sending = ref(false)
const chatBody = ref(null)

const myName = computed(() => (auth.user?.username || '').toLowerCase())

const unread = computed(() =>
  messages.value.filter(m => !isMine(m) && !m.read).length
)

function isMine(msg) {
  return (msg.from || '').toLowerCase() === myName.value
}

function fmtTime(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  return isNaN(d) ? ts : d.toLocaleString('en-US', {
    month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit'
  })
}

async function load() {
  try {
    const res = await api.get('/api/investor/messages')
    messages.value = res.messages || []
    await nextTick()
    scrollBottom()
  } catch { /* silent */ }
}

async function send() {
  const text = draft.value.trim()
  if (!text || sending.value) return
  sending.value = true
  // Optimistic
  const optimistic = {
    id: Date.now(),
    from: auth.user?.username,
    to: 'dispatch',
    message: text,
    timestamp: new Date().toISOString(),
    read: 1,
  }
  messages.value.push(optimistic)
  draft.value = ''
  await nextTick()
  scrollBottom()
  try {
    await api.post('/api/messages', {
      from: auth.user?.username,
      to: 'dispatch',
      message: text,
    })
  } catch {
    // Remove optimistic on failure
    messages.value = messages.value.filter(m => m.id !== optimistic.id)
  } finally {
    sending.value = false
  }
}

function scrollBottom() {
  if (chatBody.value) {
    chatBody.value.scrollTop = chatBody.value.scrollHeight
  }
}

function onNewMessage(payload) {
  const toLower = (payload.to || '').toLowerCase()
  const fromLower = (payload.from || '').toLowerCase()
  if (toLower === myName.value || fromLower === myName.value) {
    // Replace optimistic or add new
    const idx = messages.value.findIndex(m => m.id === payload.id)
    if (idx === -1) {
      messages.value.push(payload)
      nextTick(scrollBottom)
    }
  }
}

onMounted(() => {
  load()
  socket.on('new-message', onNewMessage)
})

onUnmounted(() => {
  socket.off('new-message', onNewMessage)
})
</script>

<style scoped>
.section {
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius); padding: 1.25rem; margin-bottom: 1.25rem;
}
.section-title {
  font-size: 0.95rem; font-weight: 700; margin-bottom: 1rem;
  display: flex; align-items: center; gap: 0.5rem;
}
.section-icon {
  width: 28px; height: 28px; border-radius: 8px;
  display: flex; align-items: center; justify-content: center; font-size: 0.9rem;
}
.unread-badge {
  background: var(--danger); color: #fff;
  font-size: 0.65rem; font-weight: 700;
  padding: 0.15rem 0.45rem; border-radius: 10px; margin-left: 2px;
}

.chat-body {
  height: 320px; overflow-y: auto; padding: 0.5rem 0;
  border: 1px solid var(--border); border-radius: 8px;
  background: var(--bg); margin-bottom: 0.75rem;
  display: flex; flex-direction: column; gap: 0.5rem; padding: 0.75rem;
}
.chat-empty {
  text-align: center; color: var(--text-dim);
  font-size: 0.82rem; margin: auto;
}

.bubble-row {
  display: flex;
}
.bubble-row.mine { justify-content: flex-end; }
.bubble-row.theirs { justify-content: flex-start; }

.bubble {
  max-width: 72%; padding: 0.6rem 0.85rem;
  border-radius: 14px; font-size: 0.85rem;
}
.bubble-row.mine .bubble {
  background: var(--accent); color: #fff;
  border-bottom-right-radius: 4px;
}
.bubble-row.theirs .bubble {
  background: var(--surface); border: 1px solid var(--border);
  color: var(--text); border-bottom-left-radius: 4px;
}

.bubble-meta {
  display: flex; justify-content: space-between; gap: 0.75rem;
  margin-bottom: 0.2rem;
}
.bubble-from {
  font-size: 0.68rem; font-weight: 700;
  opacity: 0.75; text-transform: uppercase; letter-spacing: 0.04em;
}
.bubble-time { font-size: 0.65rem; opacity: 0.6; white-space: nowrap; }
.bubble-text { line-height: 1.45; word-break: break-word; }

.chat-composer {
  display: flex; gap: 0.5rem; align-items: flex-end;
}
.chat-input {
  flex: 1; padding: 0.6rem 0.75rem; border: 1px solid var(--border);
  border-radius: 8px; font-family: inherit; font-size: 0.85rem;
  background: var(--bg); color: var(--text); resize: none; outline: none;
  transition: border-color 0.15s;
}
.chat-input:focus { border-color: var(--accent); }
.send-btn {
  padding: 0.6rem 1.25rem; background: var(--accent); color: #fff;
  border: none; border-radius: 8px; font-family: inherit;
  font-size: 0.85rem; font-weight: 600; cursor: pointer;
  transition: opacity 0.15s; white-space: nowrap;
}
.send-btn:hover { opacity: 0.85; }
.send-btn:disabled { opacity: 0.35; cursor: not-allowed; }
</style>
