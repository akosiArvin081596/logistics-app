import { defineStore } from 'pinia'
import { useApi } from '../composables/useApi'

const api = useApi()

export const useDriverStore = defineStore('driver', {
  state: () => ({
    driverName: '',
    loads: [],
    driverInfo: null,
    truck: null,
    messages: [],
    notifications: [],
    expenses: [],
    drivers: [],
    headers: { jobTracking: [], carrierDB: [] },
    acceptedLoadIds: new Set(),
    onboarding: null,
    invoices: [],
    sharedDocuments: [],
    truckDocuments: [],
    application: null,
    profilePictureUrl: '',
    driverDirectoryId: 0,
    currentTab: 'loads',
    selectedStatusLoad: null,
    isLoading: true,
    // Filters
    loadSubTab: 'active',
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

    workingLoads(state) {
      const statusCol = findCol(state.headers.jobTracking, /status/i)
      const loadIdCol = findCol(state.headers.jobTracking, /load.?id|job.?id/i)
      if (!statusCol) return []
      const workingRe = /^(assigned|heading to shipper|at shipper|loading|in transit|at receiver)$/i
      const filtered = state.loads.filter((l) => {
        const hasId = loadIdCol ? !!(l[loadIdCol] || '').trim() : true
        return hasId && workingRe.test((l[statusCol] || '').trim())
      })
      // Sort by _rowIndex descending so the most recently added load is first,
      // preventing old loads with stale statuses from being picked for GPS tracking
      return filtered.sort((a, b) => (b._rowIndex || 0) - (a._rowIndex || 0))
    },

    // The single load currently being progressed (Heading to Shipper..Unloading).
    // Returns null if none — in that case the driver app treats queuedLoads[0]
    // as the effective active load (passive promotion on delivery).
    inProgressLoad(state) {
      const statusCol = findCol(state.headers.jobTracking, /status/i)
      if (!statusCol) return null
      const loadIdCol = findCol(state.headers.jobTracking, /load.?id|job.?id/i)
      const inProgressRe = /^(heading to shipper|at shipper|loading|in transit|at receiver|unloading)$/i
      const matches = state.loads.filter((l) => {
        const hasId = loadIdCol ? !!(l[loadIdCol] || '').trim() : true
        return hasId && inProgressRe.test((l[statusCol] || '').trim())
      })
      if (matches.length === 0) return null
      // Degraded path: if two loads ended up in an in-progress status (legacy
      // state or manual sheet edit), pick the highest _rowIndex so the driver
      // sees the freshest one.
      return matches.sort((a, b) => (b._rowIndex || 0) - (a._rowIndex || 0))[0]
    },

    // Accepted-but-not-yet-started loads ordered by FIFO queue position.
    // _queuePosition is set by the server (computeDriverQueues). Falls back to
    // accepted_at, then _rowIndex if positions are missing — degrades gracefully
    // on a stale client cache that hasn't seen the new endpoint response.
    queuedLoads(state) {
      const statusCol = findCol(state.headers.jobTracking, /status/i)
      if (!statusCol) return []
      const loadIdCol = findCol(state.headers.jobTracking, /load.?id|job.?id/i)
      const assignedRe = /^assigned$/i
      const matches = state.loads.filter((l) => {
        const hasId = loadIdCol ? !!(l[loadIdCol] || '').trim() : true
        return hasId && assignedRe.test((l[statusCol] || '').trim())
      })
      return matches.sort((a, b) => {
        const pa = a._queuePosition || 0
        const pb = b._queuePosition || 0
        if (pa && pb) return pa - pb
        if (pa) return -1
        if (pb) return 1
        const ta = a._acceptedAt || ''
        const tb = b._acceptedAt || ''
        if (ta && tb && ta !== tb) return ta.localeCompare(tb)
        return (a._rowIndex || 0) - (b._rowIndex || 0)
      })
    },

    pendingLoads(state) {
      // Phase 2 (deferred acceptance): while the driver has an in-progression
      // load or an Assigned load, dispatched offers stay hidden in the Pending
      // sub-tab. They reappear once the driver delivers their current load.
      // The backend at POST /api/driver/respond also returns 409 if the driver
      // tries to accept while busy, so this is UX clarity / no-failed-clicks,
      // not the source-of-truth guard.
      if (this.inProgressLoad || this.queuedLoads.length > 0) return []
      const statusCol = findCol(state.headers.jobTracking, /status/i)
      const loadIdCol = findCol(state.headers.jobTracking, /load.?id|job.?id/i)
      if (!statusCol) return []
      const pendingRe = /^(dispatched)$/i
      return state.loads.filter((l) => {
        const hasId = loadIdCol ? !!(l[loadIdCol] || '').trim() : true
        const status = (l[statusCol] || '').trim()
        return hasId && status && pendingRe.test(status)
      })
    },

    historicalLoads(state) {
      const statusCol = findCol(state.headers.jobTracking, /status/i)
      const loadIdCol = findCol(state.headers.jobTracking, /load.?id|job.?id/i)
      if (!statusCol) return []
      const completedRe = /^(delivered|completed|pod received)$/i
      return state.loads.filter((l) => {
        const hasId = loadIdCol ? !!(l[loadIdCol] || '').trim() : true
        return hasId && completedRe.test((l[statusCol] || '').trim())
      })
    },

    hasActiveJob() {
      return this.workingLoads.length > 0
    },

    isLoadAccepted(state) {
      return (loadId) => state.acceptedLoadIds.has(loadId)
    },

    unreadCount(state) {
      return state.messages.filter(
        (m) =>
          (m.to || '').toLowerCase() === state.driverName.toLowerCase() &&
          !m.read
      ).length
    },

    unreadNotifCount(state) {
      return state.notifications.filter((n) => !n.read).length
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
      const loadIdCol = findCol(headers, /load.?id|job.?id/i)
      const originCol = findCol(headers, /origin|pickup.*city|shipper.*city|pickup.*info/i)
      const destCol = findCol(headers, /dest|drop.*city|receiver.*city|delivery.*city|consignee.*city|drop.*info/i)
      const pickupDateCol = findCol(headers, /pickup.*date|pickup.*appoint/i)
      const delivDateCol = findCol(headers, /drop.?off.*date|drop.?off.*appoint|deliv.*date|deliv.*appoint|completion.*date/i)

      // Start from the sub-tab category
      let result
      if (state.loadSubTab === 'pending') result = [...this.pendingLoads]
      else if (state.loadSubTab === 'historical') result = [...this.historicalLoads]
      else result = [...this.workingLoads]

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

      // Active sub-tab: in-progress load(s) on top, then queued loads in FIFO
      // queue order. This way a driver looking at the Active list sees their
      // current load first, then the "Up Next" loads in the order they'll
      // pick them up. _queuePosition is set by the server (computeDriverQueues).
      if (state.loadSubTab === 'active') {
        const statusCol = findCol(headers, /status/i)
        const inProgressRe = /^(heading to shipper|at shipper|loading|in transit|at receiver|unloading)$/i
        result.sort((a, b) => {
          const aInProg = statusCol ? inProgressRe.test((a[statusCol] || '').trim()) : false
          const bInProg = statusCol ? inProgressRe.test((b[statusCol] || '').trim()) : false
          if (aInProg && !bInProg) return -1
          if (!aInProg && bInProg) return 1
          // Both in-progress (degraded state): newest row first.
          if (aInProg && bInProg) return (b._rowIndex || 0) - (a._rowIndex || 0)
          // Both queued (status === Assigned): sort by queue position ASC.
          const pa = a._queuePosition || 0
          const pb = b._queuePosition || 0
          if (pa && pb) return pa - pb
          if (pa) return -1
          if (pb) return 1
          return (b._rowIndex || 0) - (a._rowIndex || 0)
        })
      }

      // Sort historical loads by most recent first
      if (state.loadSubTab === 'historical') {
        const statusUpdateCol = findCol(headers, /status.*update.*date/i)
        const completionCol = findCol(headers, /completion.*date/i)
        const sortDateCol = statusUpdateCol || completionCol || delivDateCol || pickupDateCol
        result.sort((a, b) => {
          // Try date-based sort first
          if (sortDateCol) {
            const da = new Date((a[sortDateCol] || '').replace(/(\d{1,2}:\d{2})\s*-\s*\d{1,2}:\d{2}/, '$1').replace(/^Date:\s*/i, '').trim())
            const db = new Date((b[sortDateCol] || '').replace(/(\d{1,2}:\d{2})\s*-\s*\d{1,2}:\d{2}/, '$1').replace(/^Date:\s*/i, '').trim())
            const ta = isNaN(da) ? 0 : da.getTime()
            const tb = isNaN(db) ? 0 : db.getTime()
            if (ta !== tb) return tb - ta
          }
          // Fall back to row index (newer rows are at the bottom of the sheet)
          return (b._rowIndex || 0) - (a._rowIndex || 0)
        })
      }

      return result
    },
  },

  actions: {
    async loadData() {
      if (!this.driverName) return
      if (this._loadingPromise) return this._loadingPromise
      this.isLoading = true
      this._loadingPromise = api.get(
        `/api/driver/${encodeURIComponent(this.driverName)}`
      )
      try {
        const data = await this._loadingPromise
        this.loads = data.loads || []
        // Build accepted set from _accepted flag
        const lidCol = findCol(data.headers?.jobTracking || [], /load.?id|job.?id/i)
        this.acceptedLoadIds = new Set(
          this.loads
            .filter(l => l._accepted)
            .map(l => lidCol ? (l[lidCol] || '') : '')
            .filter(Boolean)
        )
        this.driverInfo = data.driverInfo || null
        this.truck = data.truck || null
        this.messages = data.messages || []
        this.notifications = data.notifications || []
        this.expenses = data.expenses || []
        this.drivers = data.drivers || []
        this.headers = data.headers || { jobTracking: [], carrierDB: [] }
        // Only overwrite onboarding/application when the server actually
        // returned a record. A transient missing field used to flicker
        // `isOnboarding` false → drivers got bounced to the regular UI for
        // ~1-2s on a slow connection after signing a document.
        if (data.onboarding !== undefined) this.onboarding = data.onboarding
        this.invoices = data.invoices || []
        this.sharedDocuments = data.sharedDocuments || []
        this.truckDocuments = data.truckDocuments || []
        if (data.application !== undefined) this.application = data.application
        this.profilePictureUrl = data.profilePictureUrl || ''
        this.driverDirectoryId = data.driverDirectoryId || 0

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
        this._loadingPromise = null
        this.isLoading = false
      }
    },

    async respondToLoad(loadId, rowIndex, response) {
      await api.post('/api/driver/respond', {
        loadId,
        rowIndex,
        response,
        driverName: this.driverName,
      })
      if (response === 'accepted') {
        this.acceptedLoadIds.add(loadId)
      }
      // Refresh from server. If the refresh itself fails (network blip,
      // 500), undo the optimistic accept so the UI doesn't lie and let the
      // caller surface the error.
      try {
        await this.loadData()
        // After accept, the load's status moves from "Dispatched" to
        // "Assigned" so it exits pendingLoads and enters workingLoads. Nudge
        // the sub-tab so the driver sees where the load went without a
        // refresh — otherwise filteredLoads stays empty on the Pending tab.
        if (response === 'accepted') this.loadSubTab = 'active'
      } catch (err) {
        if (response === 'accepted') this.acceptedLoadIds.delete(loadId)
        throw err
      }
    },

    async updateStatus(loadId, newStatus, rowIndex, rowData) {
      await api.put('/api/driver/status', {
        driverName: this.driverName,
        loadId,
        newStatus,
        rowIndex,
        rowData,
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

    async markNotificationsRead(ids) {
      if (!ids || ids.length === 0) return
      try {
        await api.put('/api/notifications/read', { ids })
        ids.forEach((id) => {
          const n = this.notifications.find((n) => n.id === id)
          if (n) n.read = 1
        })
      } catch {
        // ignore
      }
    },

    addNotification(notif) {
      this.notifications.unshift(notif)
    },

    async signDocument(docKey, signatureText, signatureImage, paymentInfo) {
      const userId = this.onboarding?.user_id
      if (!userId) throw new Error('No onboarding record')
      const data = await api.post(`/api/onboarding/${userId}/documents/${docKey}/sign`, {
        signatureText,
        signatureImage: signatureImage || undefined,
        paymentInfo: paymentInfo || undefined,
      })
      await this.loadData()
      return data
    },

    async generateInvoice(weekEnd) {
      const data = await api.post('/api/invoices/generate', {
        driver: this.driverName,
        weekEnd,
      })
      await this.loadData()
      return data
    },

    async submitInvoice(invoiceId) {
      await api.put(`/api/invoices/${invoiceId}/submit`)
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
