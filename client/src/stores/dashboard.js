import { defineStore } from 'pinia'
import { useApi } from '../composables/useApi'
import { resolveLoadRoute } from '../lib/address'

const api = useApi()

export const useDashboardStore = defineStore('dashboard', {
  state: () => ({
    data: null,
    timestamp: null,
    isLoading: true,
  }),

  getters: {
    kpis: (s) => s.data?.kpis || null,
    revenue: (s) => s.data?.kpis?.revenue || { total: 0, paid: 0, pending: 0 },
    unassignedJobs: (s) => s.data?.unassignedJobs || [],
    activeJobs: (s) => s.data?.activeJobs || [],
    completedJobs: (s) => s.data?.completedJobs || [],
    fleet: (s) => s.data?.fleet || [],
    drivers: (s) => s.data?.drivers || [],
    driverQueues: (s) => s.data?.driverQueues || {},
    headers: (s) => s.data?.jobTrackingHeaders || [],
    completedHeaders: (s) => s.data?.completedHeaders || s.data?.jobTrackingHeaders || [],
  },

  actions: {
    async refresh() {
      try {
        const data = await api.get('/api/dashboard')
        this.data = data
        this.timestamp = data.timestamp
      } catch (err) {
        throw err
      } finally {
        this.isLoading = false
      }
    },

    // `origin` / `destination` are not cosmetic here: the server builds the
    // driver's "load assigned" notification body and the load-assigned socket
    // payload out of them, so whatever this sends is what the driver reads.
    //
    // \u26a0\ufe0f It used to derive them by splitting the `Details` column on a hyphen.
    // Two compounding faults: the origin/destination regexes were
    // /origin|pickup.*city|\u2026/ and Job Tracking's columns are `Pickup Info` /
    // `Pickup Address` / `Drop-off Address` \u2014 no "city" anywhere \u2014 so both
    // lookups returned undefined and the `Details` fallback fired on EVERY
    // dispatch. That was survivable only while n8n was overwriting `Details`
    // with a route. On a load carrying its real commodity the driver was told
    // his route was "12x32 DAIRY PURE WholeMilk, 43,764 lbs \u2192 1,575 Case(s)".
    // resolveLoadRoute() reads the address columns the sheet actually has, and
    // consults `Details` only when it is genuinely route-shaped.
    async assignDriver(rowIndex, driver, job, headers) {
      const loadIdCol = headers.find((h) => /load.?id|job.?id/i.test(h))
      const loadId = loadIdCol ? job[loadIdCol] || '' : ''
      const { origin, destination } = resolveLoadRoute(job, headers)

      await api.post('/api/dispatch', { rowIndex, driver, loadId, origin, destination })
    },

    async reassignDriver(rowIndex, newDriver, job, headers) {
      const loadIdCol = headers.find((h) => /load.?id|job.?id/i.test(h))
      const driverCol = headers.find((h) => /driver/i.test(h))
      const loadId = loadIdCol ? job[loadIdCol] || '' : ''
      const oldDriver = driverCol ? job[driverCol] || '' : ''
      await api.post('/api/dispatch/reassign', { rowIndex, newDriver, loadId, oldDriver })
    },

    // `reason` is required by the server (400 CANCEL_REASON_REQUIRED without
    // one) and is stored on the status-history row, so a cancellation can
    // always answer "why", not just who and when.
    async cancelLoad(rowIndex, job, headers, reason) {
      const loadIdCol = headers.find((h) => /load.?id|job.?id/i.test(h))
      const driverCol = headers.find((h) => /driver/i.test(h))
      const loadId = loadIdCol ? job[loadIdCol] || '' : ''
      const driver = driverCol ? job[driverCol] || '' : ''
      await api.post('/api/dispatch/cancel', { rowIndex, loadId, driver, reason })
    },

    async deleteLoad(loadId) {
      if (!loadId) throw new Error('No load id')
      await api.del(`/api/loads/${encodeURIComponent(loadId)}`)
    },

    async updateStatus(rowIndex, driverName, loadId, newStatus, rowData) {
      await api.put('/api/driver/status', { rowIndex, driverName, loadId, newStatus, rowData })
    },
  },
})
