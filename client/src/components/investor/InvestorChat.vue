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
        No messages yet. Send a message to get in touch with the admin.
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

    <!-- Composer (hidden in preview mode — admins shouldn't message themselves as the investor) -->
    <!-- The drop target is the whole composer, never the paperclip: a 24px icon
         is not something anyone can hit with a dragged file. -->
    <div
      v-if="!isPreview"
      class="chat-composer"
      :class="{ 'is-drop-active': dragActive }"
      v-bind="dropzoneProps"
    >
      <span v-if="dragActive" class="composer-drop-hint" aria-hidden="true">Drop to attach</span>
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
            <input :ref="setInputEl" v-bind="inputProps" style="display:none" />
          </label>
          <select v-if="trucks.length" v-model="selectedAsset" class="asset-select" title="Share asset">
            <option value="">&#128666; Share Truck</option>
            <option v-for="t in trucks" :key="t.id" :value="t.UnitNumber || t.unit_number">{{ t.UnitNumber || t.unit_number }}</option>
          </select>
          <span v-if="attachFile" class="attach-preview">{{ attachFile.name }} <button class="attach-clear" @click="clearAttach">&times;</button></span>
          <button class="send-btn" style="margin-left:auto;" :disabled="(!draft.trim() && !attachFile && !selectedAsset) || sending" @click="send">
            {{ sending ? '...' : 'Send' }}
          </button>
        </div>
        <!-- The only message slot on this surface — this component has no toast.
             Copy comes straight from the shared validator and stays plain: an
             investor reads it, so it never names an admin action or an internal
             route. -->
        <p v-if="attachError" class="composer-error" role="alert">
          <span>{{ attachError }}</span>
          <button type="button" class="attach-clear" aria-label="Dismiss" @click="clearMessages">&times;</button>
        </p>
      </div>
    </div>
    <div v-else class="chat-readonly-hint">
      Read-only preview &mdash; sending messages is disabled while viewing this investor's portal.
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted, nextTick } from 'vue'
import { useApi } from '../../composables/useApi'
import { useSocket } from '../../composables/useSocket'
import { useFileDrop } from '../../composables/useFileDrop'
import { readFileAsDataURL } from '../../lib/imageUtils'
import { useAuthStore } from '../../stores/auth'
import { useInvestorStore } from '../../stores/investor'

const props = defineProps({
  trucks: { type: Array, default: () => [] },
  // Super Admin previewing this investor's portal — when set we fetch the
  // target investor's thread and hide the send composer.
  previewUserId: { type: Number, default: null },
  isPreview: { type: Boolean, default: false },
})

const api = useApi()
const socket = useSocket()
const auth = useAuthStore()
const investorStore = useInvestorStore()

const messages = ref([])
const draft = ref('')
const sending = ref(false)
const chatBody = ref(null)
const attachFile = ref(null)
const selectedAsset = ref('')
const attachBase64 = ref('')

// Receives an already-validated File[] from BOTH paths — the paperclip picker
// and a drop anywhere on the composer. `multiple` is off, so at most one file
// ever arrives; a second is refused by name in `attachError`.
async function onAttach(files) {
  const file = files[0]
  if (!file) return
  const dataUrl = await readFileAsDataURL(file)
  // readFileAsDataURL resolves '' on an unreadable/corrupt file rather than
  // rejecting. Showing the name with no bytes behind it would let send() run
  // and silently post a message with no attachment, so refuse it here.
  if (!dataUrl) {
    attachFile.value = null
    attachBase64.value = ''
    attachError.value = `Couldn’t read “${file.name}”. Try attaching it again.`
    return
  }
  attachFile.value = file
  attachBase64.value = dataUrl
}

// `.pdf` sits beside `application/pdf` on purpose: Windows hands us PDFs with
// file.type === '', and a MIME-only rule would refuse them on a drop even
// though the picker (and the server) accept them. 10 MB matches the 13.5M
// base64 ceiling on POST /api/chat/attachment.
const {
  dropzoneProps,
  inputProps,
  setInputEl,
  dragActive,
  error: attachError,
  clearMessages,
} = useFileDrop({
  accept: 'image/*,application/pdf,.pdf',
  maxSizeMb: 10,
  onFiles: onAttach,
})

function clearAttach() {
  attachFile.value = null
  attachBase64.value = ''
}

// In preview mode "me" is the target investor whose portal we're replicating,
// not the admin viewing it — that way the chat bubbles mirror what the
// investor actually sees (their own messages on the right).
const myName = computed(() => {
  if (props.isPreview) {
    return (investorStore.data?.investor?.username || '').toLowerCase()
  }
  return (auth.user?.username || '').toLowerCase()
})

const unread = computed(() =>
  messages.value.filter(m => !isMine(m) && !m.read).length
)

function isMine(msg) {
  return (msg.from || '').toLowerCase() === myName.value
}

// Houston rule: pinned to America/Chicago with a visible zone label. Investors
// are not necessarily in Houston, so the label is what keeps the timestamp
// honest for an out-of-state reader. `msg.timestamp` is a true instant (ISO-Z).
function fmtTime(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  return isNaN(d) ? ts : d.toLocaleString('en-US', {
    month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
    timeZone: 'America/Chicago', timeZoneName: 'short',
  })
}

async function load() {
  try {
    const url = props.isPreview && props.previewUserId
      ? `/api/investor/messages?as_user_id=${props.previewUserId}`
      : '/api/investor/messages'
    const res = await api.get(url)
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
    to: 'admin',
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
        mimeType: savedFile.type,
      })
      attachmentUrl = uploadRes.fileUrl || ''
      attachmentType = uploadRes.attachmentType || (savedFile.type.startsWith('image/') ? 'image' : 'file')
      optimistic.attachment_url = attachmentUrl
      optimistic.attachment_type = attachmentType
    }
    await api.post('/api/messages', {
      from: auth.user?.username,
      to: 'admin',
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
  // Skip own messages (already added optimistically)
  if (fromLower === myName.value) return
  if (toLower === myName.value || fromLower === myName.value) {
    messages.value.push(payload)
    nextTick(scrollBottom)
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

/* The composer is the drop target. position:relative only contains the hint. */
.chat-composer {
  display: flex; gap: 0.5rem; align-items: flex-end;
  position: relative;
  border-radius: 8px;
}
.chat-composer.is-drop-active { background: var(--accent-dim); }

/* pointer-events:none is load-bearing, not polish. The hint appears UNDER the
   cursor mid-drag; if it could be an event target it would fire its own
   dragenter with no matching dragleave on the composer and desync the depth
   counter, leaving the highlight stuck on. Absolute so it can't reflow the
   composer — and move the drop target — at the moment of the drop. */
.composer-drop-hint {
  position: absolute; inset: 0; z-index: 1;
  display: flex; align-items: center; justify-content: center;
  pointer-events: none;
  border: 1.5px dashed var(--accent); border-radius: 8px;
  background: var(--accent-dim); color: var(--accent);
  font-size: 0.8rem; font-weight: 700; letter-spacing: 0.02em;
}

.composer-error {
  display: flex; align-items: flex-start; justify-content: space-between;
  gap: 0.5rem; margin: 0;
  padding: 0.35rem 0.6rem; border-radius: 6px;
  background: #fef2f2; border: 1px solid #fecaca;
  color: #b91c1c; font-size: 0.72rem; line-height: 1.4;
}
.composer-error .attach-clear { color: #b91c1c; }
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
  padding: 0.6rem 1.25rem; background: #0284c7; color: #fff;
  border: none; border-radius: 8px; font-family: inherit;
  font-size: 0.85rem; font-weight: 600; cursor: pointer;
  transition: all 0.15s; white-space: nowrap;
  box-shadow: 0 2px 6px rgba(2, 132, 199, 0.3);
}
.send-btn:hover { background: #0369a1; }
.send-btn:disabled { opacity: 0.4; cursor: not-allowed; box-shadow: none; background: #94a3b8; }
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
.chat-readonly-hint {
  padding: 0.6rem 0.75rem;
  background: #f8fafc;
  border: 1px dashed var(--border);
  border-radius: 8px;
  font-size: 0.78rem;
  color: var(--text-dim);
  text-align: center;
  font-style: italic;
}
</style>
