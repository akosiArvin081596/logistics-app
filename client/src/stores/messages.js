import { defineStore } from 'pinia'
import { useApi } from '../composables/useApi'
import { voiceNoteLabel } from '../lib/voiceNoteText'
import { uploadVoiceNote } from '../lib/voiceNoteUpload'

const api = useApi()

// The staff desks a message to staff is addressed to: a driver writes to
// "Dispatch", an investor to "admin" (server.js CHAT_DESK_NAMES). Opening a
// conversation marks both read, as GET /api/messages counts both unread.
const STAFF_DESKS = ['dispatch', 'admin']

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
          .filter((m) => STAFF_DESKS.includes(m.to.toLowerCase()) && !m.read)
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

    // A voice note from Dispatch (MESSAGE_VOICE_NOTES_ENABLED). Unlike a text,
    // it shows once the server has it: its id is what plays it. Throws on
    // failure; the composer keeps the clip and the same key for the retry.
    async sendVoiceNote(driver, loadId, clip) {
      const sent = await uploadVoiceNote(api.request, {
        blob: clip.blob,
        to: driver,
        loadId: loadId || '',
        from: 'Dispatch',
        key: clip.key,
        durationMs: clip.durationMs,
      })
      const open = this.selectedDriver && this.selectedDriver.toLowerCase() === String(driver).toLowerCase()
      if (open && !this.currentMessages.some((m) => m.id === sent.id)) {
        this.currentMessages.push({
          id: sent.id,
          timestamp: new Date().toISOString(),
          from: 'Dispatch',
          to: driver,
          message: voiceNoteLabel(sent.durationMs),
          loadId: loadId || '',
          read: 1,
          attachment_url: '',
          attachment_type: 'voice',
          voice_duration_ms: sent.durationMs,
        })
      }
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
          // A photo that arrives live shows (and opens full size) without a reload.
          attachment_url: msg.attachment_url || '',
          attachment_type: msg.attachment_type || '',
          // A voice note plays live too, at the length the server measured.
          voice_duration_ms: Number(msg.voice_duration_ms) || 0,
        })
        if (msg.id) {
          api.put('/api/messages/read', { messageIds: [msg.id] })
        }
      }
    },
  },
})
