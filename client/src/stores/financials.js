import { defineStore } from 'pinia'
import { useApi } from '../composables/useApi'

const api = useApi()

export const useFinancialsStore = defineStore('financials', {
  state: () => ({
    summary: null,
    expensesByCategory: {},
    perTruck: [],
    loads: { highest: [], lowest: [] },
    drivers: [],
    isLoading: false,
    lastError: '',
    lastFetched: 0,
  }),

  actions: {
    async load() {
      this.isLoading = true
      this.lastError = ''
      try {
        const data = await api.get('/api/financials')
        this.summary = data.summary || null
        this.expensesByCategory = data.expensesByCategory || {}
        this.perTruck = data.perTruck || []
        this.loads = data.loads || { highest: [], lowest: [] }
        this.drivers = data.drivers || []
        this.lastFetched = Date.now()
      } catch (err) {
        this.lastError = err?.message || 'Failed to load financials'
      } finally {
        this.isLoading = false
      }
    },
  },
})
