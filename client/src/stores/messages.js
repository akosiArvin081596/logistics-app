import { defineStore } from 'pinia'
import { useApi } from '../composables/useApi'

const api = useApi()

export const useMessagesStore = defineStore('messages', {
  state: () => ({
    conversations: [],
    selectedDriver: null,
    selectedLoadId: '',
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

    async selectConversation(driverName, loadId) {
      this.selectedDriver = driverName
      this.selectedLoadId = loadId || ''
      try {
        const query = loadId
          ? `/api/messages/${encodeURIComponent(driverName)}?loadId=${encodeURIComponent(loadId)}`
          : `/api/messages/${encodeURIComponent(driverName)}`
        const data = await api.get(query)
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

    // Keep backward compat for old callers
    async selectDriver(name) {
      return this.selectConversation(name, '')
    },

    async sendMessage(driver, message, loadId, attachmentUrl, attachmentType) {
      await api.post('/api/messages', {
        from: 'Dispatch',
        to: driver,
        message,
        loadId: loadId || '',
        attachmentUrl: attachmentUrl || '',
        attachmentType: attachmentType || '',
      })
      // Optimistic update
      this.currentMessages.push({
        id: 0,
        timestamp: new Date().toISOString(),
        from: 'Dispatch',
        to: driver,
        message,
        loadId: loadId || '',
        read: 1,
        attachment_url: attachmentUrl || '',
        attachment_type: attachmentType || '',
      })
      this.loadConversations()
    },

    addIncomingMessage(msg) {
      this.loadConversations()
      // If viewing this driver's chat for this load, add it
      if (
        this.selectedDriver &&
        msg.from.toLowerCase() === this.selectedDriver.toLowerCase() &&
        (!this.selectedLoadId || msg.loadId === this.selectedLoadId)
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
        if (msg.id) {
          api.put('/api/messages/read', { messageIds: [msg.id] })
        }
      }
    },
  },
})
