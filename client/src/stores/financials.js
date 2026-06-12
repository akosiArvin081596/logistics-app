import { defineStore } from 'pinia'
import { useApi } from '../composables/useApi'

const api = useApi()

export const useFinancialsStore = defineStore('financials', {
  state: () => ({
    summary: null,
    expensesByCategory: {},
    monthlyPerformance: [],
    perTruck: [],
    loads: { highest: [], lowest: [] },
    drivers: [],
    isLoading: false,
    lastError: '',
    lastFetched: 0,
    // Month drill-down (?month=YYYY-MM on the same endpoint)
    monthDetail: null,
    monthLoading: false,
    monthError: '',
  }),

  actions: {
    applyPayload(data) {
      this.summary = data.summary || null
      this.expensesByCategory = data.expensesByCategory || {}
      this.monthlyPerformance = data.monthlyPerformance || []
      this.perTruck = data.perTruck || []
      this.loads = data.loads || { highest: [], lowest: [] }
      this.drivers = data.drivers || []
      this.lastFetched = Date.now()
    },

    async load() {
      this.isLoading = true
      this.lastError = ''
      try {
        const data = await api.get('/api/financials')
        this.applyPayload(data)
      } catch (err) {
        this.lastError = err?.message || 'Failed to load financials'
      } finally {
        this.isLoading = false
      }
    },

    // Fetch the drill-down for one month. The endpoint returns the full
    // payload plus `monthDetail`, so the main view refreshes for free and the
    // modal numbers always reconcile with the table row that was clicked.
    // A request token drops stale responses when months are clicked rapidly.
    async loadMonth(month) {
      const reqId = (this._monthReqId = (this._monthReqId || 0) + 1)
      this.monthLoading = true
      this.monthError = ''
      this.monthDetail = null
      try {
        const data = await api.get(`/api/financials?month=${encodeURIComponent(month)}`)
        if (reqId !== this._monthReqId) return // a newer request superseded this one
        this.applyPayload(data)
        this.monthDetail = data.monthDetail || null
        if (!this.monthDetail) this.monthError = 'No detail returned for this month'
      } catch (err) {
        if (reqId !== this._monthReqId) return
        this.monthError = err?.message || 'Failed to load month detail'
      } finally {
        if (reqId === this._monthReqId) this.monthLoading = false
      }
    },

    clearMonth() {
      this.monthDetail = null
      this.monthError = ''
    },
  },
})
