<template>
  <div class="msg-layout">
    <!-- Sidebar: conversations grouped by driver + load -->
    <div class="msg-sidebar" style="position:relative;">
      <div class="msg-sidebar-header">
        Conversations
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
import { ref, watch, nextTick } from 'vue'
import { useMessagesStore } from '../../stores/messages'
import { useToast } from '../../composables/useToast'
import ChatBubble from './ChatBubble.vue'
import EmptyState from '../shared/EmptyState.vue'

const store = useMessagesStore()
const { show: toast } = useToast()

const messageInput = ref('')
const messagesEl = ref(null)

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
