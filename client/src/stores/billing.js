import { defineStore } from 'pinia'
import { useApi } from '../composables/useApi'

const api = useApi()

// "Ready for Billing" queue — loads whose signed BOL upload triggered the
// Post-Trip Draft Engine. Each row is either a staged Gmail draft
// (status 'drafted') or a load that couldn't be assembled yet
// (status 'pending' — see `lastError`, e.g. a missing rate-con). Mirrors the
// invoices store shape (plain state + load()); the queue is a small, transient
// work list, so no pagination/filtering lives here.
export const useBillingStore = defineStore('billing', {
  state: () => ({
    loads: [],
    isLoading: false,
  }),

  getters: {
    draftedCount: (s) => s.loads.filter(l => l.status === 'drafted').length,
    pendingCount: (s) => s.loads.filter(l => l.status === 'pending').length,
  },

  actions: {
    async load() {
      this.isLoading = true
      try {
        const res = await api.get('/api/billing/queue')
        this.loads = res.loads || []
      } finally {
        this.isLoading = false
      }
    },

    // (Re)generate the staged Gmail draft for one load — used for 'pending' rows
    // and manual re-drafts. Resolves to { success, invoiceId, draftSubject } or
    // throws with the server's { error }. The caller refreshes the queue after.
    async generateDraft(loadId) {
      return api.post(`/api/billing/${encodeURIComponent(loadId)}/draft`, {})
    },
  },
})
