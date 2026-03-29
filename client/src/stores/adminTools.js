import { defineStore } from 'pinia'
import { useApi } from '../composables/useApi'

const api = useApi()

export const useAdminToolsStore = defineStore('adminTools', {
  state: () => ({
    duplicates: null,
    driverMismatches: null,
    orphans: null,
    staleLocations: null,
    scanningDuplicates: false,
    scanningMismatches: false,
    scanningOrphans: false,
    scanningStaleLocations: false,
  }),

  actions: {
    async scanDuplicates() {
      this.scanningDuplicates = true
      try {
        this.duplicates = await api.get('/api/admin/scan-duplicates')
      } finally {
        this.scanningDuplicates = false
      }
    },

    async scanDriverMismatches() {
      this.scanningMismatches = true
      try {
        this.driverMismatches = await api.get('/api/admin/scan-driver-mismatches')
      } finally {
        this.scanningMismatches = false
      }
    },

    async scanOrphans() {
      this.scanningOrphans = true
      try {
        this.orphans = await api.get('/api/admin/scan-orphans')
      } finally {
        this.scanningOrphans = false
      }
    },

    async removeRows(sheet, rowIndices) {
      return await api.post('/api/admin/remove-rows', { sheet, rowIndices })
    },

    async fixDriverName(oldName, newName) {
      return await api.put('/api/admin/fix-driver-name', { oldName, newName })
    },

    async scanStaleLocations() {
      this.scanningStaleLocations = true
      try {
        this.staleLocations = await api.get('/api/admin/scan-stale-locations')
      } finally {
        this.scanningStaleLocations = false
      }
    },

    async fixStaleLocation(driver, oldLoadId, newLoadId) {
      return await api.post('/api/admin/fix-stale-locations', { driver, oldLoadId, newLoadId })
    },
  },
})
