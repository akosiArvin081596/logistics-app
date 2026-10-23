import { defineStore } from 'pinia'
import { useApi } from '../composables/useApi'
import { voiceNoteLabel } from '../lib/voiceNoteText'
import { uploadVoiceNote } from '../lib/voiceNoteUpload'
import { loadKeyStale } from '../lib/loadRef'

const api = useApi()

// The staff desks a message to staff is addressed to: a driver writes to
// "Dispatch", an investor to "admin" (server.js CHAT_DESK_NAMES). Opening a
// conversation marks both read, as GET /api/messages counts both unread.
const STAFF_DESKS = ['dispatch', 'admin']

export const useMessagesStore = defineStore('messages', {
  state: () => ({
    conversations: [],
    selectedDriver: null,
    // The open conversation's load: selectedLoadId is the reference the thread
    // is read and replied to by (a Dispatcher's key for a withheld Load ID,
    // client/src/lib/loadRef.js, else the ID as served); selectedLoadShown is
    // the text the screen shows for it, never the key.
    selectedLoadId: '',
    selectedLoadShown: '',
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

    // `loadId`: the conversation's load reference (conversationRef()); `shown`:
    // its text as served, the reference itself when not given.
    async selectConversation(driverName, loadId, shown) {
      this.selectedDriver = driverName
      this.selectedLoadId = loadId || ''
      this.selectedLoadShown = shown == null ? this.selectedLoadId : String(shown)
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
      } catch (err) {
        // A stale key: the header shows no other conversation's thread.
        if (this.refetchIfKeyStale(err)) this.currentMessages = []
      }
    },

    // A stale load key (404 LOAD_KEY_UNKNOWN: the server restarted since the
    // list was read): the list is read again, once, for its new keys.
    refetchIfKeyStale(err) {
      if (!loadKeyStale(err)) return false
      this.loadConversations()
      return true
    },

    // Keep backward compat for old callers
    async selectDriver(name) {
      return this.selectConversation(name, '')
    },

    // `loadId`: the load reference, sent as is; the screen shows its text.
    async sendMessage(driver, message, loadId, attachmentUrl, attachmentType) {
      const shown = this.shownFor(loadId)
      try {
        await api.post('/api/messages', {
          from: 'Dispatch',
          to: driver,
          message,
          loadId: loadId || '',
          attachmentUrl: attachmentUrl || '',
          attachmentType: attachmentType || '',
        })
      } catch (err) {
        this.refetchIfKeyStale(err)
        throw err
      }
      // Optimistic update
      this.currentMessages.push({
        id: 0,
        timestamp: new Date().toISOString(),
        from: 'Dispatch',
        to: driver,
        message,
        loadId: shown,
        read: 1,
        attachment_url: attachmentUrl || '',
        attachment_type: attachmentType || '',
      })
      this.loadConversations()
    },

    // The text a sent message's load shows: the open conversation's for its
    // reference (a key never reaches the screen), else the reference as given.
    shownFor(loadId) {
      if (!loadId) return ''
      return loadId === this.selectedLoadId ? this.selectedLoadShown : loadId
    },

    // A voice note from Dispatch (MESSAGE_VOICE_NOTES_ENABLED). Unlike a text,
    // it shows once the server has it: its id is what plays it. Throws on
    // failure; the composer keeps the clip and the same key for the retry.
    async sendVoiceNote(driver, loadId, clip) {
      const shown = this.shownFor(loadId)
      let sent
      try {
        sent = await uploadVoiceNote(api.request, {
          blob: clip.blob,
          to: driver,
          loadId: loadId || '',
          from: 'Dispatch',
          key: clip.key,
          durationMs: clip.durationMs,
        })
      } catch (err) {
        this.refetchIfKeyStale(err)
        throw err
      }
      const open = this.selectedDriver && this.selectedDriver.toLowerCase() === String(driver).toLowerCase()
      if (open && !this.currentMessages.some((m) => m.id === sent.id)) {
        this.currentMessages.push({
          id: sent.id,
          timestamp: new Date().toISOString(),
          from: 'Dispatch',
          to: driver,
          message: voiceNoteLabel(sent.durationMs),
          loadId: shown,
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
      // If viewing this driver's chat for this load, add it. A thread opened by
      // its key matches the live copy's load by the text it shows (the dispatch
      // room is sent each withheld load as shown).
      if (
        this.selectedDriver &&
        msg.from.toLowerCase() === this.selectedDriver.toLowerCase() &&
        (!this.selectedLoadId || msg.loadId === this.selectedLoadId ||
          (!!this.selectedLoadShown && msg.loadId === this.selectedLoadShown))
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
