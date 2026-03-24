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
      const loadId = loadIdCol ? job[loadIdCol] || '' : ''
      const values = headers.map((h) => {
        if (/^driver$/i.test(h)) return driver
        if (/^status$/i.test(h)) return 'Dispatched'
        return job[h] || ''
      })
      await api.post('/api/dispatch', { rowIndex, driver, loadId, values })
    },
  },
})
