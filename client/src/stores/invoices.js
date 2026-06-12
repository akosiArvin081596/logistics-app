import { defineStore } from 'pinia'
import { useApi } from '../composables/useApi'

const api = useApi()

// Soft-deleted rows are only present when the admin opted into the
// "show deleted" view — KPI math must always ignore them.
const live = (s) => s.invoices.filter(i => !i.deleted_at)

export const useInvoicesStore = defineStore('invoices', {
  state: () => ({
    invoices: [],
    isLoading: false,
    showDeleted: false,
  }),

  getters: {
    byStatus: (s) => (status) => live(s).filter(i => i.status === status),
    draftCount:      (s) => live(s).filter(i => i.status === 'Draft').length,
    submittedCount:  (s) => live(s).filter(i => i.status === 'Submitted').length,
    approvedCount:   (s) => live(s).filter(i => i.status === 'Approved').length,
    processingCount: (s) => live(s).filter(i => i.status === 'Processing').length,
    paidCount:       (s) => live(s).filter(i => i.status === 'Paid').length,
    rejectedCount:   (s) => live(s).filter(i => i.status === 'Rejected').length,
    totalSubmitted:  (s) => live(s).filter(i => i.status === 'Submitted').reduce((sum, i) => sum + (i.total_earnings || 0), 0),
    totalApproved:   (s) => live(s).filter(i => i.status === 'Approved').reduce((sum, i) => sum + (i.total_earnings || 0), 0),
    totalProcessing: (s) => live(s).filter(i => i.status === 'Processing').reduce((sum, i) => sum + (i.total_earnings || 0), 0),
    totalPaid:       (s) => live(s).filter(i => i.status === 'Paid').reduce((sum, i) => sum + (i.total_earnings || 0), 0),
  },

  actions: {
    async load() {
      this.isLoading = true
      try {
        const url = this.showDeleted ? '/api/invoices?include_deleted=true' : '/api/invoices'
        const res = await api.get(url)
        this.invoices = res.invoices || []
      } finally {
        this.isLoading = false
      }
    },

    async setShowDeleted(value) {
      this.showDeleted = !!value
      await this.load()
    },

    // action: 'approve' | 'reject' | 'processing' | 'paid'
    async updateStatus(id, action, rejectionNote) {
      const body = { action }
      if (action === 'reject' && rejectionNote) body.rejectionNote = rejectionNote
      await api.put(`/api/invoices/${id}/approve`, body)
      await this.load()
    },

    // Super Admin only. Sets a +/- adjustment line on ANY invoice (including
    // Approved/Processing/Paid — post-approval edits are audit-flagged
    // server-side). Pass amount=0 to clear an existing adjustment.
    async adjust(id, amount, note) {
      const res = await api.put(`/api/invoices/${id}/adjust`, {
        adjustment: Number(amount) || 0,
        adjustmentNote: note || '',
      })
      await this.load()
      return res
    },

    // Super Admin only. Driver submits via the driver store; this is used for
    // admin-created manual invoices (Draft → Submitted).
    async submit(id) {
      await api.put(`/api/invoices/${id}/submit`)
      await this.load()
    },

    // Super Admin only. Approved/Processing/Paid/Rejected → Submitted so the
    // invoice can be corrected and re-approved.
    async revert(id, reason) {
      const res = await api.put(`/api/invoices/${id}/revert`, { reason: reason || '' })
      await this.load()
      return res
    },

    // Super Admin only. Soft delete — who/when/why is recorded server-side.
    async remove(id, reason) {
      const qs = reason ? `?reason=${encodeURIComponent(reason)}` : ''
      await api.del(`/api/invoices/${id}${qs}`)
      await this.load()
    },

    // Super Admin only. Restore a soft-deleted invoice.
    async restore(id) {
      const res = await api.put(`/api/invoices/${id}/restore`, {})
      await this.load()
      return res
    },

    // Super Admin only. Create a from-scratch (manual) invoice.
    async createManual(payload) {
      const res = await api.post('/api/invoices/manual', payload)
      await this.load()
      return res
    },

    // Super Admin only. Payment-summary report for one payee.
    // params: { payee, week } or { payee, from, to }
    async fetchReport(params) {
      const qs = new URLSearchParams()
      qs.set('payee', params.payee || '')
      if (params.week) qs.set('week', params.week)
      else { qs.set('from', params.from || ''); qs.set('to', params.to || '') }
      return api.get(`/api/invoices/report?${qs.toString()}`)
    },
  },
})
