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

    // `confirm` and `reason` are both required by the server (400
    // CONFIRMATION_REQUIRED / DELETE_REASON_REQUIRED). Deleting sheet rows is
    // irreversible and rows in a finalized month are refused outright, so the
    // caller must state intent and the reason is written to audit_trail with the
    // deleted contents.
    async removeRows(sheet, rowIndices, reason) {
      return await api.post('/api/admin/remove-rows', {
        sheet,
        rowIndices,
        confirm: true,
        reason,
      })
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
