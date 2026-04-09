import { defineStore } from 'pinia'
import { useApi } from '../composables/useApi'

const api = useApi()

export const useInvoicesStore = defineStore('invoices', {
  state: () => ({
    invoices: [],
    isLoading: false,
  }),

  getters: {
    byStatus: (s) => (status) => s.invoices.filter(i => i.status === status),
    draftCount:     (s) => s.invoices.filter(i => i.status === 'Draft').length,
    submittedCount: (s) => s.invoices.filter(i => i.status === 'Submitted').length,
    approvedCount:  (s) => s.invoices.filter(i => i.status === 'Approved').length,
    paidCount:      (s) => s.invoices.filter(i => i.status === 'Paid').length,
    rejectedCount:  (s) => s.invoices.filter(i => i.status === 'Rejected').length,
    totalSubmitted: (s) => s.invoices.filter(i => i.status === 'Submitted').reduce((sum, i) => sum + (i.total_earnings || 0), 0),
    totalApproved:  (s) => s.invoices.filter(i => i.status === 'Approved').reduce((sum, i) => sum + (i.total_earnings || 0), 0),
    totalPaid:      (s) => s.invoices.filter(i => i.status === 'Paid').reduce((sum, i) => sum + (i.total_earnings || 0), 0),
  },

  actions: {
    async load() {
      this.isLoading = true
      try {
        const res = await api.get('/api/invoices')
        this.invoices = res.invoices || []
      } finally {
        this.isLoading = false
      }
    },

    // action: 'approve' | 'reject' | 'paid'
    async updateStatus(id, action, rejectionNote) {
      const body = { action }
      if (action === 'reject' && rejectionNote) body.rejectionNote = rejectionNote
      await api.put(`/api/invoices/${id}/approve`, body)
      await this.load()
    },
  },
})
