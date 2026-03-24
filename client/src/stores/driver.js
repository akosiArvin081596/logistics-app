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
    // Filters
    filterStatus: 'active',
    filterSearch: '',
    filterDateFrom: '',
    filterDateTo: '',
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

    filteredLoads(state) {
      const headers = state.headers.jobTracking
      const statusCol = findCol(headers, /status/i)
      const loadIdCol = findCol(headers, /load.?id|job.?id/i)
      const originCol = findCol(headers, /origin|pickup.*city|shipper.*city|pickup.*info/i)
      const destCol = findCol(headers, /dest|drop.*city|receiver.*city|delivery.*city|consignee.*city|drop.*info/i)
      const pickupDateCol = findCol(headers, /pickup.*date|pickup.*appoint/i)
      const delivDateCol = findCol(headers, /drop.?off.*date|drop.?off.*appoint|deliv.*date|deliv.*appoint|completion.*date/i)

      const activeRe = /^(in transit|dispatched|assigned|picked up|at shipper|at receiver|loading|unloading)$/i
      const completedRe = /^(delivered|completed|pod received)$/i

      let result = [...state.loads]

      // Status filter
      if (statusCol && state.filterStatus !== 'all') {
        result = result.filter((l) => {
          const s = (l[statusCol] || '').trim()
          const hasData = loadIdCol ? !!(l[loadIdCol] || '').trim() : true
          if (state.filterStatus === 'active') return hasData && !completedRe.test(s)
          if (state.filterStatus === 'completed') return hasData && completedRe.test(s)
          if (state.filterStatus === 'empty') return !hasData
          return true
        })
      }

      // Search filter
      if (state.filterSearch.trim()) {
        const q = state.filterSearch.trim().toLowerCase()
        const detailsCol = findCol(headers, /details/i)
        result = result.filter((l) => {
          const fields = [
            loadIdCol && l[loadIdCol],
            originCol && l[originCol],
            destCol && l[destCol],
            detailsCol && l[detailsCol],
          ].filter(Boolean)
          return fields.some((f) => f.toLowerCase().includes(q))
        })
      }

      // Date range filter
      if (state.filterDateFrom || state.filterDateTo) {
        const dateCol = pickupDateCol || delivDateCol
        if (dateCol) {
          const from = state.filterDateFrom ? new Date(state.filterDateFrom) : null
          const to = state.filterDateTo ? new Date(state.filterDateTo) : null
          if (to) to.setHours(23, 59, 59, 999)
          result = result.filter((l) => {
            const raw = l[dateCol]
            if (!raw) return false
            const cleaned = raw.replace(/(\d{1,2}:\d{2})\s*-\s*\d{1,2}:\d{2}/, '$1').trim()
            const d = new Date(cleaned)
            if (isNaN(d)) return false
            if (from && d < from) return false
            if (to && d > to) return false
            return true
          })
        }
      }

      // Sort: active loads first
      if (statusCol) {
        result.sort((a, b) => {
          const aActive = activeRe.test((a[statusCol] || '').trim())
          const bActive = activeRe.test((b[statusCol] || '').trim())
          if (aActive && !bActive) return -1
          if (!aActive && bActive) return 1
          return 0
        })
      }

      return result
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
