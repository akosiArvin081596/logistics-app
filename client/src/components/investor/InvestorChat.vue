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
          <div v-if="msg.asset_ref" class="bubble-asset"><span class="asset-badge">&#128666; {{ msg.asset_ref }}</span></div>
          <div v-if="msg.message" class="bubble-text">{{ msg.message }}</div>
          <div v-if="msg.attachment_url" class="bubble-attachment">
            <a v-if="msg.attachment_type === 'image'" :href="msg.attachment_url" target="_blank" rel="noopener">
              <img :src="msg.attachment_url" class="attach-img" />
            </a>
            <a v-else :href="msg.attachment_url" target="_blank" rel="noopener" class="attach-link">
              &#128206; {{ msg.attachment_url.split('/').pop() }}
            </a>
          </div>
        </div>
      </div>
    </div>

    <!-- Composer -->
    <div class="chat-composer">
      <div class="composer-main">
        <textarea
          v-model="draft"
          class="chat-input"
          placeholder="Type a message..."
          rows="2"
          @keydown.enter.exact.prevent="send"
        ></textarea>
        <div class="composer-toolbar">
          <label class="attach-btn" title="Attach file">
            &#128206;
            <input type="file" style="display:none" accept="image/*,application/pdf" @change="onAttach" />
          </label>
          <select v-if="trucks.length" v-model="selectedAsset" class="asset-select" title="Share asset">
            <option value="">&#128666; Share Truck</option>
            <option v-for="t in trucks" :key="t.id" :value="t.UnitNumber || t.unit_number">{{ t.UnitNumber || t.unit_number }}</option>
          </select>
          <span v-if="attachFile" class="attach-preview">{{ attachFile.name }} <button class="attach-clear" @click="clearAttach">&times;</button></span>
        </div>
      </div>
      <button class="send-btn" :disabled="(!draft.trim() && !attachFile && !selectedAsset) || sending" @click="send">
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

const props = defineProps({
  trucks: { type: Array, default: () => [] },
})

const api = useApi()
const socket = useSocket()
const auth = useAuthStore()

const messages = ref([])
const draft = ref('')
const sending = ref(false)
const chatBody = ref(null)
const attachFile = ref(null)
const selectedAsset = ref('')
const attachBase64 = ref('')

function onAttach(e) {
  const file = e.target.files[0]
  if (!file) return
  attachFile.value = file
  const reader = new FileReader()
  reader.onload = ev => { attachBase64.value = ev.target.result }
  reader.readAsDataURL(file)
  e.target.value = ''
}

function clearAttach() {
  attachFile.value = null
  attachBase64.value = ''
}

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
  const assetRef = selectedAsset.value || ''
  if ((!text && !attachFile.value && !assetRef) || sending.value) return
  sending.value = true
  const optimistic = {
    id: Date.now(),
    asset_ref: assetRef,
    from: auth.user?.username,
    to: 'dispatch',
    message: text,
    timestamp: new Date().toISOString(),
    read: 1,
    attachment_url: '',
    attachment_type: '',
  }
  messages.value.push(optimistic)
  draft.value = ''
  const savedFile = attachFile.value
  const savedBase64 = attachBase64.value
  attachFile.value = null
  attachBase64.value = ''
  await nextTick()
  scrollBottom()
  try {
    let attachmentUrl = ''
    let attachmentType = ''
    if (savedFile && savedBase64) {
      const uploadRes = await api.post('/api/chat/attachment', {
        fileName: savedFile.name,
        fileData: savedBase64,
        fileType: savedFile.type,
      })
      attachmentUrl = uploadRes.url || ''
      attachmentType = savedFile.type.startsWith('image/') ? 'image' : 'file'
      optimistic.attachment_url = attachmentUrl
      optimistic.attachment_type = attachmentType
    }
    await api.post('/api/messages', {
      from: auth.user?.username,
      to: 'dispatch',
      message: text,
      attachmentUrl,
      attachmentType,
      assetRef,
    })
    selectedAsset.value = ''
  } catch {
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
.composer-main { flex: 1; display: flex; flex-direction: column; gap: 0.35rem; }
.chat-input {
  width: 100%; padding: 0.6rem 0.75rem; border: 1px solid var(--border);
  border-radius: 8px; font-family: inherit; font-size: 0.85rem;
  background: var(--bg); color: var(--text); resize: none; outline: none;
  transition: border-color 0.15s; box-sizing: border-box;
}
.chat-input:focus { border-color: var(--accent); }
.composer-toolbar {
  display: flex; align-items: center; gap: 0.5rem;
}
.attach-btn {
  cursor: pointer; font-size: 1rem; padding: 0.2rem 0.4rem;
  border-radius: 5px; background: var(--bg); border: 1px solid var(--border);
  color: var(--text-dim); transition: all 0.15s; line-height: 1;
}
.attach-btn:hover { border-color: var(--accent); color: var(--accent); }
.attach-preview {
  font-size: 0.72rem; color: var(--text-dim);
  background: var(--bg); border: 1px solid var(--border);
  border-radius: 5px; padding: 0.15rem 0.5rem;
  display: flex; align-items: center; gap: 0.35rem;
}
.attach-clear {
  background: none; border: none; cursor: pointer; color: var(--danger);
  font-size: 0.85rem; line-height: 1; padding: 0;
}
.send-btn {
  padding: 0.6rem 1.25rem; background: var(--accent); color: #fff;
  border: none; border-radius: 8px; font-family: inherit;
  font-size: 0.85rem; font-weight: 600; cursor: pointer;
  transition: opacity 0.15s; white-space: nowrap;
}
.send-btn:hover { opacity: 0.85; }
.send-btn:disabled { opacity: 0.35; cursor: not-allowed; }
.bubble-attachment { margin-top: 0.3rem; }
.attach-img { max-width: 200px; max-height: 140px; border-radius: 6px; display: block; }
.attach-link {
  font-size: 0.78rem; color: inherit; opacity: 0.85; text-decoration: underline;
}
.asset-select {
  padding: 0.2rem 0.4rem; font-size: 0.72rem; font-family: inherit;
  border: 1px solid var(--border); border-radius: 5px;
  background: var(--bg); color: var(--text-dim); cursor: pointer;
}
.bubble-asset { margin-bottom: 0.2rem; }
.asset-badge {
  display: inline-flex; align-items: center; gap: 0.25rem;
  padding: 0.15rem 0.5rem; border-radius: 8px; font-size: 0.68rem; font-weight: 600;
  background: rgba(59,130,246,0.12); color: var(--blue, #3b82f6);
}
</style>
