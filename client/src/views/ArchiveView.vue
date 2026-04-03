<template>
  <div class="archive-page admin-page" style="overflow-y:auto;min-height:auto;flex:none;">
    <div class="page-header">
      <h2>Data Archive</h2>
      <span class="archive-badge">Read-Only</span>
    </div>

    <div class="card" style="margin-bottom:1rem;">
      <div class="archive-controls">
        <div class="tab-bar">
          <button v-for="tab in tabs" :key="tab" :class="['tab-btn', { active: activeTab === tab }]" @click="selectTab(tab)">
            {{ tab }}
          </button>
        </div>
        <div class="search-row">
          <input v-model="search" type="text" class="form-input" placeholder="Search archive..." style="max-width:320px;" @keydown.enter="loadData" />
          <select v-model="pageSize" class="form-input" style="width:auto;" @change="loadData">
            <option :value="25">25/page</option>
            <option :value="50">50/page</option>
            <option :value="100">100/page</option>
            <option :value="200">200/page</option>
          </select>
        </div>
      </div>
    </div>

    <div class="card">
      <div v-if="loading" style="text-align:center;padding:2rem;color:var(--text-dim);">Loading archive data...</div>
      <div v-else-if="data.length === 0" style="text-align:center;padding:2rem;color:var(--text-dim);">No data found.</div>
      <div v-else class="table-wrap">
        <table class="archive-table">
          <thead>
            <tr>
              <th v-for="h in headers" :key="h">{{ h }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in data" :key="row._rowIndex">
              <td v-for="h in headers" :key="h" :title="row[h]">{{ truncate(row[h]) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-if="total > 0" class="archive-pagination">
        <span>{{ (page - 1) * pageSize + 1 }}-{{ Math.min(page * pageSize, total) }} of {{ total }}</span>
        <div class="page-btns">
          <button class="page-btn" :disabled="page <= 1" @click="goPage(page - 1)">&lsaquo;</button>
          <button class="page-btn" :disabled="page >= totalPages" @click="goPage(page + 1)">&rsaquo;</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { useApi } from '../composables/useApi'

const api = useApi()
const tabs = ref([])
const activeTab = ref('Job Tracking')
const headers = ref([])
const data = ref([])
const total = ref(0)
const page = ref(1)
const pageSize = ref(50)
const search = ref('')
const loading = ref(false)

const totalPages = computed(() => Math.ceil(total.value / pageSize.value) || 1)

function truncate(val, max = 60) {
  if (!val) return '\u2014'
  return val.length > max ? val.substring(0, max) + '...' : val
}

async function loadTabs() {
  try {
    const res = await api.get('/api/archive/tabs')
    tabs.value = res.tabs || []
  } catch { /* silent */ }
}

async function loadData() {
  loading.value = true
  try {
    const res = await api.get(`/api/archive?sheet=${encodeURIComponent(activeTab.value)}&page=${page.value}&limit=${pageSize.value}&search=${encodeURIComponent(search.value)}`)
    headers.value = res.headers || []
    data.value = res.data || []
    total.value = res.total || 0
  } catch { /* silent */ }
  loading.value = false
}

function selectTab(tab) {
  activeTab.value = tab
  page.value = 1
  search.value = ''
  loadData()
}

function goPage(p) {
  page.value = p
  loadData()
}

onMounted(() => {
  loadTabs()
  loadData()
})
</script>

<style scoped>
.archive-badge { font-size: 0.68rem; font-weight: 600; padding: 0.2rem 0.6rem; border-radius: 8px; background: #fef3c7; color: #92400e; text-transform: uppercase; letter-spacing: 0.04em; }
.archive-controls { display: flex; flex-direction: column; gap: 0.75rem; }
.tab-bar { display: flex; gap: 0.25rem; flex-wrap: wrap; }
.tab-btn { padding: 0.4rem 0.75rem; font-size: 0.78rem; font-weight: 600; border: 1px solid var(--border); border-radius: 6px; background: var(--bg); color: var(--text-dim); cursor: pointer; transition: all 0.15s; font-family: inherit; }
.tab-btn.active { background: var(--accent); color: #fff; border-color: var(--accent); }
.tab-btn:hover:not(.active) { border-color: var(--accent); color: var(--accent); }
.search-row { display: flex; gap: 0.5rem; align-items: center; }
.table-wrap { overflow-x: auto; }
.archive-table { width: 100%; border-collapse: collapse; font-size: 0.8rem; }
.archive-table th { background: #f8fafc; padding: 0.6rem 0.75rem; text-align: left; font-size: 0.68rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: #64748b; border-bottom: 2px solid #e2e8f0; white-space: nowrap; }
.archive-table td { padding: 0.5rem 0.75rem; border-bottom: 1px solid #f1f5f9; max-width: 250px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.archive-table tr:hover td { background: #f8fafc; }
.archive-pagination { display: flex; justify-content: space-between; align-items: center; padding: 0.75rem 0; font-size: 0.8rem; color: var(--text-dim); }
.page-btns { display: flex; gap: 0.25rem; }
.page-btn { width: 32px; height: 32px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg); cursor: pointer; font-size: 1rem; display: flex; align-items: center; justify-content: center; }
.page-btn:disabled { opacity: 0.3; cursor: not-allowed; }
.page-btn:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }
</style>
