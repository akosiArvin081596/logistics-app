import { defineStore } from 'pinia'
import { useApi } from '../composables/useApi'

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

    async assignDriver(rowIndex, driver, job, headers) {
      const loadIdCol = headers.find((h) => /load.?id|job.?id/i.test(h))
      const detailsCol = headers.find((h) => /details/i.test(h))
      const originCol = headers.find((h) => /origin|pickup.*city|shipper.*city/i.test(h) && !/lat|lng|lon/i.test(h))
      const destCol = headers.find((h) => /dest|drop.*city|receiver.*city|delivery.*city|consignee.*city/i.test(h) && !/lat|lng|lon|date|time|appt|eta/i.test(h))
      const loadId = loadIdCol ? job[loadIdCol] || '' : ''

      let origin = originCol ? job[originCol] || '' : ''
      let destination = destCol ? job[destCol] || '' : ''
      if (!origin && !destination && detailsCol) {
        const details = (job[detailsCol] || '').trim()
        const parts = details.split(/\s*[-\u2192]\s*/)
        if (parts.length >= 2) {
          origin = parts[0].trim()
          destination = parts[1].trim()
        }
      }

      await api.post('/api/dispatch', { rowIndex, driver, loadId, origin, destination })
    },

    async reassignDriver(rowIndex, newDriver, job, headers) {
      const loadIdCol = headers.find((h) => /load.?id|job.?id/i.test(h))
      const driverCol = headers.find((h) => /driver/i.test(h))
      const loadId = loadIdCol ? job[loadIdCol] || '' : ''
      const oldDriver = driverCol ? job[driverCol] || '' : ''
      await api.post('/api/dispatch/reassign', { rowIndex, newDriver, loadId, oldDriver })
    },

    async cancelLoad(rowIndex, job, headers) {
      const loadIdCol = headers.find((h) => /load.?id|job.?id/i.test(h))
      const driverCol = headers.find((h) => /driver/i.test(h))
      const loadId = loadIdCol ? job[loadIdCol] || '' : ''
      const driver = driverCol ? job[driverCol] || '' : ''
      await api.post('/api/dispatch/cancel', { rowIndex, loadId, driver })
    },

    async updateStatus(rowIndex, driverName, loadId, newStatus) {
      await api.put('/api/driver/status', { rowIndex, driverName, loadId, newStatus })
    },
  },
})
