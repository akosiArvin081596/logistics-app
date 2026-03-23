<template>
  <div class="msg-layout">
    <!-- Sidebar: conversations -->
    <div class="msg-sidebar" style="position:relative;">
      <div class="msg-sidebar-header">
        Conversations
        <button class="msg-new-btn" title="New conversation" @click="showNewOverlay = true">+</button>
      </div>
      <div class="msg-driver-list">
        <div
          v-for="c in store.conversations"
          :key="c.driver"
          :class="['msg-driver-item', { active: store.selectedDriver && c.driver.toLowerCase() === store.selectedDriver.toLowerCase() }]"
          @click="store.selectDriver(c.driver)"
        >
          <div>
            <div>{{ c.driver }}</div>
            <div class="msg-time">{{ formatTime(c.lastTimestamp) }}</div>
          </div>
          <div v-if="c.unread > 0" class="msg-unread">{{ c.unread }}</div>
        </div>
        <EmptyState v-if="store.conversations.length === 0">No conversations yet.</EmptyState>
      </div>

      <!-- New conversation overlay -->
      <div v-if="showNewOverlay" class="msg-new-overlay">
        <div class="msg-new-header">
          New Message
          <button class="msg-new-btn" title="Cancel" style="background:var(--text-dim);font-size:0.85rem;" @click="showNewOverlay = false">&#10005;</button>
        </div>
        <input v-model="newSearch" class="msg-new-search" type="text" placeholder="Search drivers..." />
        <div class="msg-new-list">
          <div
            v-for="d in filteredDrivers"
            :key="d"
            class="msg-new-item"
            @click="startConversation(d)"
          >
            {{ d }}
          </div>
          <EmptyState v-if="filteredDrivers.length === 0">No drivers found.</EmptyState>
        </div>
      </div>
    </div>

    <!-- Chat area -->
    <div class="msg-chat">
      <div class="msg-chat-header">{{ store.selectedDriver || 'Select a conversation' }}</div>
      <div ref="messagesEl" class="msg-chat-messages">
        <template v-if="store.selectedDriver && store.currentMessages.length > 0">
          <ChatBubble v-for="(m, i) in store.currentMessages" :key="i" :msg="m" />
        </template>
        <EmptyState v-else-if="store.selectedDriver">No messages yet.</EmptyState>
        <EmptyState v-else>Select a driver from the left to view messages.</EmptyState>
      </div>
      <div v-if="store.selectedDriver" class="msg-chat-input">
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
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, nextTick } from 'vue'
import { useMessagesStore } from '../../stores/messages'
import { useToast } from '../../composables/useToast'
import ChatBubble from './ChatBubble.vue'
import EmptyState from '../shared/EmptyState.vue'

const props = defineProps({
  driverNames: { type: Array, default: () => [] },
})

const store = useMessagesStore()
const { show: toast } = useToast()

const messageInput = ref('')
const showNewOverlay = ref(false)
const newSearch = ref('')
const messagesEl = ref(null)

const filteredDrivers = computed(() => {
  const search = newSearch.value.trim().toLowerCase()
  const drivers = [...props.driverNames].sort((a, b) => a.localeCompare(b))
  return search ? drivers.filter((d) => d.toLowerCase().includes(search)) : drivers
})

function formatTime(ts) {
  const t = new Date(ts)
  return isNaN(t) ? '' : t.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
}

function startConversation(driver) {
  showNewOverlay.value = false
  store.selectDriver(driver)
  const exists = store.conversations.some((c) => c.driver.toLowerCase() === driver.toLowerCase())
  if (!exists) {
    store.conversations.unshift({ driver, lastTimestamp: new Date().toISOString(), unread: 0 })
  }
}

async function sendMessage() {
  const msg = messageInput.value.trim()
  if (!msg || !store.selectedDriver) return
  try {
    await store.sendMessage(store.selectedDriver, msg)
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
