import { defineStore } from 'pinia'
import { useApi } from '../composables/useApi'

const api = useApi()

export const useSheetsStore = defineStore('sheets', {
  state: () => ({
    tabs: [],
    currentSheet: 'Job Tracking',
    headers: [],
    data: [],
    total: 0,
    page: 1,
    pageSize: 5,
    totalPages: 0,
    driverList: [],
    editingRow: null,
    searchQuery: '',
    isLoading: false,
    duplicates: [],
    showDuplicates: false,
  }),

  actions: {
    async loadTabs() {
      try {
        const json = await api.get('/api/tabs')
        this.tabs = json.tabs || []
      } catch (err) {
        console.error('Failed to load tabs:', err)
      }
    },

    async loadDrivers() {
      try {
        const json = await api.get('/api/drivers-directory')
        const headers = json.headers || []
        const driverCol = headers.find((h) => /driver/i.test(h)) || headers[0]
        if (driverCol) {
          const names = (json.data || []).map((row) => row[driverCol]).filter(Boolean)
          this.driverList = [...new Set(names)].sort()
        }
      } catch (err) {
        console.error('Failed to load drivers:', err)
      }
    },

    async loadData() {
      this.isLoading = true
      try {
        const params = new URLSearchParams({
          sheet: this.currentSheet,
          page: this.page,
          limit: this.pageSize,
        })
        if (this.searchQuery.trim()) {
          params.set('search', this.searchQuery.trim())
        }
        const json = await api.get(`/api/data?${params}`)
        this.headers = json.headers || []
        this.data = json.data || []
        this.total = json.total || 0
        this.totalPages = json.totalPages || 0
        this.duplicates = json.duplicates || []
      } catch (err) {
        console.error('Failed to load data:', err)
        throw err
      } finally {
        this.isLoading = false
      }
    },

    async addRow(values) {
      const result = await api.post(
        `/api/data?sheet=${encodeURIComponent(this.currentSheet)}`,
        { values }
      )
      await this.loadData()
      return result
    },

    // Returns the server's response so the view can report `preserved` — the
    // broker/contact columns a non-Super-Admin was served redacted, which the
    // server restores rather than writing the redacted copy back over the record.
    async saveRow(rowIndex, values) {
      const result = await api.put(
        `/api/data/${rowIndex}?sheet=${encodeURIComponent(this.currentSheet)}`,
        { values }
      )
      this.editingRow = null
      await this.loadData()
      return result
    },

    // `reason` is required by the server (400 DELETE_REASON_REQUIRED without it)
    // and is stored in audit_trail alongside the deleted row's contents — a
    // sheet row delete is irreversible, so the record has to say why.
    async deleteRow(rowIndex, reason) {
      await api.del(
        `/api/data/${rowIndex}?sheet=${encodeURIComponent(this.currentSheet)}`,
        { body: JSON.stringify({ reason }) }
      )
      await this.loadData()
    },

    setSearch(query) {
      this.searchQuery = query
      this.page = 1
      this.editingRow = null
      this.loadData()
    },

    switchSheet(name) {
      this.currentSheet = name
      this.page = 1
      this.searchQuery = ''
      this.editingRow = null
      this.loadData()
    },

    setPage(page) {
      this.page = page
      this.editingRow = null
      this.loadData()
    },

    setPageSize(size) {
      this.pageSize = size
      this.page = 1
      this.editingRow = null
      this.loadData()
    },
  },
})
