import { defineStore } from 'pinia'
import { useApi } from '../composables/useApi'

const api = useApi()

export const useDriverStore = defineStore('driver', {
  state: () => ({
    driverName: '',
    loads: [],
    driverInfo: null,
    messages: [],
    expenses: [],
    drivers: [],
    headers: { jobTracking: [], carrierDB: [] },
    currentTab: 'loads',
    selectedStatusLoad: null,
    isLoading: true,
  }),

  getters: {
    activeLoads(state) {
      const statusCol = findCol(state.headers.jobTracking, /status/i)
      if (!statusCol) return state.loads
      const completedRe = /^(delivered|completed|pod received)$/i
      return state.loads.filter(
        (l) => !completedRe.test((l[statusCol] || '').trim())
      )
    },

    unreadCount(state) {
      return state.messages.filter(
        (m) =>
          (m.to || '').toLowerCase() === state.driverName.toLowerCase() &&
          !m.read
      ).length
    },

    sortedLoads(state) {
      const statusCol = findCol(state.headers.jobTracking, /status/i)
      if (!statusCol) return [...state.loads]
      const activeRe =
        /^(in transit|dispatched|assigned|picked up|at shipper|at receiver|loading|unloading)$/i
      return [...state.loads].sort((a, b) => {
        const aActive = activeRe.test((a[statusCol] || '').trim())
        const bActive = activeRe.test((b[statusCol] || '').trim())
        if (aActive && !bActive) return -1
        if (!aActive && bActive) return 1
        return 0
      })
    },
  },

  actions: {
    async loadData() {
      if (!this.driverName) return
      this.isLoading = true
      try {
        const data = await api.get(
          `/api/driver/${encodeURIComponent(this.driverName)}`
        )
        this.loads = data.loads || []
        this.driverInfo = data.driverInfo || null
        this.messages = data.messages || []
        this.expenses = data.expenses || []
        this.drivers = data.drivers || []
        this.headers = data.headers || { jobTracking: [], carrierDB: [] }

        // Keep selected status load in sync
        if (this.selectedStatusLoad) {
          const match = this.loads.find(
            (l) => l._rowIndex === this.selectedStatusLoad._rowIndex
          )
          this.selectedStatusLoad = match || null
        }
      } catch {
        throw new Error('Failed to load driver data')
      } finally {
        this.isLoading = false
      }
    },

    async updateStatus(loadId, newStatus, rowIndex, headers) {
      await api.put('/api/driver/status', {
        driverName: this.driverName,
        loadId,
        newStatus,
        rowIndex,
        allHeaders: headers,
      })
      await this.loadData()
    },

    async sendMessage(recipient, message, loadId) {
      await api.post('/api/messages', {
        from: this.driverName,
        to: recipient,
        message,
        loadId,
      })
      // Optimistic update
      this.messages.push({
        id: 0,
        timestamp: new Date().toISOString(),
        from: this.driverName,
        to: recipient,
        message,
        loadId,
        read: 1,
      })
    },

    async markMessagesRead(ids) {
      if (!ids || ids.length === 0) return
      try {
        await api.put('/api/messages/read', { messageIds: ids })
        ids.forEach((id) => {
          const msg = this.messages.find((m) => m.id === id)
          if (msg) msg.read = 1
        })
      } catch {
        // ignore
      }
    },

    async submitExpense(data) {
      await api.post('/api/expenses', data)
      await this.loadData()
    },

    addIncomingMessage(msg) {
      this.messages.push({
        id: msg.id || 0,
        timestamp: msg.timestamp,
        from: msg.from,
        to: msg.to,
        message: msg.message,
        loadId: msg.loadId || '',
        read: this.currentTab === 'messages' ? 1 : 0,
      })
    },
  },
})

/* helper shared across store */
function findCol(headers, regex) {
  return (headers || []).find((h) => regex.test(h)) || null
}
