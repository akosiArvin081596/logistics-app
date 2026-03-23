import { defineStore } from 'pinia'
import { useApi } from '../composables/useApi'

const api = useApi()

export const useInvestorStore = defineStore('investor', {
  state: () => ({
    data: null,
    isLoading: true,
  }),

  getters: {
    production: (s) => s.data?.production || null,
    asset: (s) => s.data?.asset || null,
    taxShield: (s) => s.data?.taxShield || null,
    recessionProof: (s) => s.data?.recessionProof || null,
    config: (s) => s.data?.config || null,
  },

  actions: {
    async load() {
      this.isLoading = true
      try {
        const data = await api.get('/api/investor')
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
  },
})
