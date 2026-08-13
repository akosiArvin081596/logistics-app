<template>
  <div :class="['msg-layout', { 'msg-has-active': !!store.selectedDriver }]">
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
          <option value="" disabled>Select recipient</option>
          <option v-for="d in props.driverNames" :key="d" :value="d">{{ d }}</option>
        </select>
        <select v-model="newLoadId" class="new-msg-select" :disabled="!newDriver">
          <option value="">General</option>
          <option v-for="id in loadsForDriver" :key="id" :value="id">Load {{ id }}</option>
        </select>
        <button class="new-msg-start" :disabled="!newDriver" @click="startConversation">Open Chat</button>
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
            <div v-else class="msg-load-label">General</div>
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
        <!-- Mobile back arrow — returns to the conversation list. Hidden on
             desktop via CSS; the two-pane grid means both are visible. -->
        <button
          v-if="store.selectedDriver"
          class="msg-back-btn"
          aria-label="Back to conversations"
          @click="deselectConversation"
        >&#8592;</button>
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
      <div v-if="attachPreview" class="msg-attach-preview">
        <span>{{ attachFileName }}</span>
        <button class="msg-attach-remove" @click="clearAttachment">&times;</button>
      </div>
      <!-- ONE message slot for every refusal the attach path can produce (wrong
           type, over 10 MB, a second file, a dropped folder). Inline rather than
           a toast: the composer is where the mistake was made, and a toast that
           re-fires with identical text is easy to miss on a repeat. -->
      <div v-if="attachError" class="msg-attach-error" role="alert">
        <span>{{ attachError }}</span>
        <button class="msg-attach-remove" aria-label="Dismiss" @click="clearMessages">&times;</button>
      </div>
      <!-- The drop target is the whole composer ROW, never the paperclip — a
           24px icon is not something anyone can hit with a dragged file. -->
      <div
        v-if="store.selectedDriver"
        class="msg-chat-input"
        :class="{ 'is-drop-active': dragActive }"
        v-bind="dropzoneProps"
      >
        <span v-if="dragActive" class="msg-drop-hint" aria-hidden="true">Drop to attach</span>
        <label class="msg-attach-btn" title="Attach file">
          &#128206;
          <input :ref="setInputEl" v-bind="inputProps" style="display:none" />
        </label>
        <input
          v-model="messageInput"
          type="text"
          class="msg-input"
          :placeholder="store.selectedLoadId ? 'Reply to driver...' : 'Reply...'"
          maxlength="500"
          @keydown.enter.prevent="sendMessage"
        />
        <button class="msg-send-btn" @click="sendMessage">&#10148;</button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, nextTick } from 'vue'
import { useMessagesStore } from '../../stores/messages'
import { useApi } from '../../composables/useApi'
import { useDashboardStore } from '../../stores/dashboard'
import { useToast } from '../../composables/useToast'
import { useFileDrop } from '../../composables/useFileDrop'
import { readFileAsDataURL } from '../../lib/imageUtils'
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
const attachPreview = ref(null)
const attachFileName = ref('')
const attachData = ref('')
const attachType = ref('')

// Receives an already-validated File[] from BOTH paths — the paperclip picker
// and a drop anywhere on the composer row. `multiple` is off, so at most one
// file ever arrives; a second is refused by name in `attachError`.
async function onAttachFile(files) {
  const file = files[0]
  if (!file) return
  const dataUrl = await readFileAsDataURL(file)
  // readFileAsDataURL resolves '' on an unreadable/corrupt file rather than
  // rejecting, so an empty result is the failure signal — never a valid attach.
  if (!dataUrl) {
    attachError.value = `Couldn't read "${file.name}". Try attaching it again.`
    return
  }
  attachFileName.value = file.name
  attachType.value = file.type.startsWith('image/') ? 'image' : file.type === 'application/pdf' ? 'pdf' : 'other'
  attachData.value = dataUrl
  attachPreview.value = true
}

// `accept` is unchanged from the markup it replaces, but it now MEANS something
// on a drop as well: the attribute alone only filters the OS dialog, so without
// this a dropped .docx would reach POST /api/chat/attachment. 10 MB matches that
// route's 13.5M base64 ceiling (server.js:30503).
const {
  dropzoneProps,
  inputProps,
  setInputEl,
  dragActive,
  error: attachError,
  clearMessages,
} = useFileDrop({
  accept: 'image/*,.pdf',
  maxSizeMb: 10,
  onFiles: onAttachFile,
})

function clearAttachment() { attachPreview.value = null; attachData.value = ''; attachFileName.value = ''; attachType.value = '' }

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

function deselectConversation() {
  // Clears the active conversation so the mobile view returns to the
  // conversation list. Desktop doesn't use this — both panes are always
  // visible there.
  if (store.selectConversation) store.selectConversation('', '')
}

function selectConversation(c) {
  store.selectConversation(c.driver, c.loadId || '')
}

// Conversation-list "last message" time. Houston rule: pinned to
// America/Chicago with a visible zone label so the owner (Houston) and the
// developer (Manila) share one login and still read the same clock.
function formatTime(ts) {
  const t = new Date(ts)
  return isNaN(t) ? '' : t.toLocaleTimeString('en-US', {
    hour: 'numeric', minute: '2-digit',
    timeZone: 'America/Chicago', timeZoneName: 'short',
  })
}

async function sendMessage() {
  const msg = messageInput.value.trim()
  if ((!msg && !attachData.value) || !store.selectedDriver) return
  try {
    let attachmentUrl = '', attachmentType = ''
    if (attachData.value) {
      const api = useApi()
      const res = await api.post('/api/chat/attachment', { fileData: attachData.value, fileName: attachFileName.value, mimeType: attachType.value })
      attachmentUrl = res.fileUrl || ''
      attachmentType = res.attachmentType || ''
    }
    await store.sendMessage(store.selectedDriver, msg, store.selectedLoadId, attachmentUrl, attachmentType)
    messageInput.value = ''
    clearAttachment()
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

/* The composer row is the drop target (dropzoneProps are bound to it in the
   template). MessagesView.vue owns the row's base look via :deep(); these rules
   only add the drag state, and each carries an extra class so it outranks that
   deep selector regardless of stylesheet order.

   position:relative exists solely to contain the hint below — MessagesView sets
   no position on this row, so nothing is being overridden. */
.msg-chat-input {
  position: relative;
}
.msg-chat-input.is-drop-active {
  background: var(--accent-dim);
}

/* pointer-events:none is load-bearing, not polish. The hint appears UNDER the
   cursor mid-drag; if it could be an event target it would fire its own
   dragenter without a matching dragleave on the row and desync the composable's
   depth counter, leaving the highlight stuck on. Absolute positioning keeps it
   from reflowing the row (and moving the drop target) at the same moment. */
.msg-drop-hint {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
  border: 1.5px dashed var(--accent);
  border-radius: var(--radius);
  background: var(--accent-dim);
  color: var(--accent);
  font-size: 0.78rem;
  font-weight: 700;
  letter-spacing: 0.02em;
}

.msg-attach-error {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.5rem;
  padding: 0.4rem 1rem;
  background: #fef2f2;
  border-top: 1px solid #fecaca;
  font-size: 0.75rem;
  line-height: 1.4;
  color: #b91c1c;
}
.msg-attach-error .msg-attach-remove {
  color: #b91c1c;
}
</style>
