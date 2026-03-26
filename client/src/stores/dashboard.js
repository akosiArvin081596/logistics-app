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
    fleet: (s) => s.data?.fleet || [],
    drivers: (s) => s.data?.drivers || [],
    headers: (s) => s.data?.jobTrackingHeaders || [],
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
      const statusCol = headers.find((h) => /status/i.test(h))
      const driverCol = headers.find((h) => /^driver$/i.test(h))
      const detailsCol = headers.find((h) => /details/i.test(h))
      const originCol = headers.find((h) => /origin|pickup.*city|shipper.*city/i.test(h))
      const destCol = headers.find((h) => /dest|drop.*city|receiver.*city|delivery.*city|consignee.*city/i.test(h))
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

      const values = headers.map((h) => {
        if (h === driverCol) return driver
        if (h === statusCol) return 'Dispatched'
        return job[h] || ''
      })
      await api.post('/api/dispatch', { rowIndex, driver, loadId, origin, destination, values })
    },
  },
})
