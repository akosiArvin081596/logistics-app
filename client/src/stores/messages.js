import { defineStore } from 'pinia'
import { useApi } from '../composables/useApi'

const api = useApi()

export const useMessagesStore = defineStore('messages', {
  state: () => ({
    conversations: [],
    selectedDriver: null,
    currentMessages: [],
  }),

  getters: {
    totalUnread: (s) => s.conversations.reduce((sum, c) => sum + (c.unread || 0), 0),
  },

  actions: {
    async loadConversations() {
      try {
        const data = await api.get('/api/messages')
        this.conversations = data.conversations || []
      } catch {
        // ignore
      }
    },

    async selectDriver(name) {
      this.selectedDriver = name
      try {
        const data = await api.get(`/api/messages/${encodeURIComponent(name)}`)
        this.currentMessages = data.messages || []
        // Mark unread as read
        const unreadIds = this.currentMessages
          .filter((m) => m.to.toLowerCase() === 'dispatch' && !m.read)
          .map((m) => m.id)
        if (unreadIds.length > 0) {
          await api.put('/api/messages/read', { messageIds: unreadIds })
          this.loadConversations()
        }
      } catch {
        // ignore
      }
    },

    async sendMessage(driver, message) {
      await api.post('/api/messages', {
        from: 'Dispatch',
        to: driver,
        message,
        loadId: '',
      })
      // Optimistic update
      this.currentMessages.push({
        id: 0,
        timestamp: new Date().toISOString(),
        from: 'Dispatch',
        to: driver,
        message,
        loadId: '',
        read: 1,
      })
      this.loadConversations()
    },

    addIncomingMessage(msg) {
      // Refresh conversations
      this.loadConversations()
      // If viewing this driver's chat, add it
      if (
        this.selectedDriver &&
        msg.from.toLowerCase() === this.selectedDriver.toLowerCase()
      ) {
        this.currentMessages.push({
          id: msg.id || 0,
          timestamp: msg.timestamp,
          from: msg.from,
          to: msg.to,
          message: msg.message,
          loadId: msg.loadId || '',
          read: 1,
        })
        // Mark as read
        if (msg.id) {
          api.put('/api/messages/read', { messageIds: [msg.id] })
        }
      }
    },
  },
})
