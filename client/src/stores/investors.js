import { defineStore } from 'pinia'
import { useApi } from '../composables/useApi'

const api = useApi()

export const useInvestorsStore = defineStore('investors', {
  state: () => ({
    investors: [],
    investorUsers: [],
    isLoading: false,
    // Monthly payout ledger (Super Admin) — one statement per investor
    // portal account: per-month loads/revenue/owed + paid status.
    payoutStatements: [],
    payoutsLoading: false,
  }),

  actions: {
    async load() {
      this.isLoading = true
      try {
        const data = await api.get('/api/investors')
        this.investors = data.investors || []
      } finally {
        this.isLoading = false
      }
    },

    async loadInvestorUsers() {
      try {
        const data = await api.get('/api/users/investors')
        this.investorUsers = data.investors || []
      } catch {
        console.error('Failed to load investor users')
      }
    },

    async add(data) {
      await api.post('/api/investors', data)
      await this.load()
    },

    async update(id, data) {
      await api.put(`/api/investors/${id}`, data)
      await this.load()
    },

    async remove(id) {
      await api.del(`/api/investors/${id}`)
      await this.load()
    },

    // ---- Monthly payout ledger (Super Admin) ----
    async loadPayouts() {
      this.payoutsLoading = true
      try {
        const data = await api.get('/api/admin/investor-payouts')
        this.payoutStatements = data.statements || []
      } finally {
        this.payoutsLoading = false
      }
    },

    // Mark a month as paid out. { investorUserId, month: 'YYYY-MM', amount, note }
    async markPayoutPaid(payload) {
      await api.post('/api/admin/investor-payouts', payload)
      await this.loadPayouts()
    },

    // Undo a mistaken mark-as-paid (reverts the month to Pending).
    async unmarkPayout(payoutId) {
      await api.del(`/api/admin/investor-payouts/${payoutId}`)
      await this.loadPayouts()
    },
  },
})
