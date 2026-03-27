import { defineStore } from 'pinia'
import { useApi } from '../composables/useApi'

const api = useApi()

export const useDispatchNotificationsStore = defineStore('dispatchNotifications', {
  state: () => ({
    notifications: [],
    unreadCount: 0,
  }),

  actions: {
    async fetch() {
      try {
        const data = await api.get('/api/dispatch-notifications')
        this.notifications = data.notifications || []
        this.unreadCount = data.unreadCount || 0
      } catch {
        // silent
      }
    },

    async markAllRead() {
      try {
        await api.put('/api/dispatch-notifications/read', {})
        this.notifications.forEach(n => { n.read = 1 })
        this.unreadCount = 0
      } catch {
        // silent
      }
    },

    async markRead(ids) {
      try {
        await api.put('/api/dispatch-notifications/read', { ids })
        ids.forEach(id => {
          const n = this.notifications.find(x => x.id === id)
          if (n) n.read = 1
        })
        this.unreadCount = Math.max(0, this.unreadCount - ids.length)
      } catch {
        // silent
      }
    },

    addRealtime(notification) {
      this.notifications.unshift(notification)
      this.unreadCount++
    },
  },
})
