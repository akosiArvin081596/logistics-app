import { defineStore } from 'pinia'
import { useApi } from '../composables/useApi'

const api = useApi()

export const useInvestorStore = defineStore('investor', {
  state: () => ({
    data: null,
    isLoading: true,
    // Set when a Super Admin is previewing a specific investor's portal via
    // /investor-portals/:userId. All API calls thread this through as
    // `?as_user_id=N` so the backend scopes data to that investor instead of
    // the session user. null = normal session-scoped behavior.
    previewUserId: null,
  }),

  getters: {
    production: (s) => s.data?.production || null,
    asset: (s) => s.data?.asset || null,
    taxShield: (s) => s.data?.taxShield || null,
    recessionProof: (s) => s.data?.recessionProof || null,
    config: (s) => s.data?.config || null,
    myLoads: (s) => s.data?.myLoads || { pending: [], active: [] },
    // Monthly payout statements (owed vs paid per month). Empty for the
    // fleet-wide Super Admin view — only investor-scoped requests get rows.
    payouts: (s) => s.data?.payouts || [],
    isPreview: (s) => s.previewUserId != null,
    previewQuery: (s) => (s.previewUserId != null ? `as_user_id=${s.previewUserId}` : ''),
  },

  actions: {
    async load() {
      this.isLoading = true
      try {
        const qs = this.previewUserId != null ? `?as_user_id=${this.previewUserId}` : ''
        const data = await api.get(`/api/investor${qs}`)
        this.data = data
      } catch (err) {
        throw err
      } finally {
        this.isLoading = false
      }
    },

    async updateConfig(config) {
      const data = await api.put('/api/investor/config', config)
      if (this.data) {
        this.data.config = data.config || config
      }
    },

    // Enter preview mode for a given investor user_id. Reset data so the UI
    // doesn't flash stale numbers from the previously-previewed investor
    // while the new fetch is in flight (singleton store gotcha).
    setPreview(userId) {
      const id = parseInt(userId, 10)
      this.previewUserId = Number.isFinite(id) && id > 0 ? id : null
      this.data = null
      this.isLoading = true
    },

    clearPreview() {
      this.previewUserId = null
      this.data = null
      this.isLoading = true
    },
  },
})
