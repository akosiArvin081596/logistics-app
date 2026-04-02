<template>
  <div class="section">
    <div class="section-title">
      <div class="section-icon" style="background: var(--blue-dim); color: var(--blue);">&#128196;</div>
      Document Portal
      <span class="doc-count">{{ filtered.length }} files</span>
    </div>

    <!-- Filter bar -->
    <div class="filter-bar">
      <button
        v-for="f in filters"
        :key="f"
        :class="['filter-btn', { active: activeFilter === f }]"
        @click="activeFilter = f"
      >{{ f }}</button>
      <input
        v-model="search"
        class="doc-search"
        placeholder="Search load ID or driver..."
      />
    </div>

    <div v-if="loading" class="empty-state">Loading documents...</div>
    <div v-else-if="filtered.length === 0" class="empty-state">No documents found.</div>

    <table v-else class="doc-table">
      <thead>
        <tr>
          <th>Type</th>
          <th>Load ID</th>
          <th>Driver</th>
          <th>File</th>
          <th>Uploaded</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="doc in filtered" :key="doc.id">
          <td><span :class="['type-badge', typeClass(doc.type)]">{{ doc.type }}</span></td>
          <td class="mono">{{ doc.load_id || '—' }}</td>
          <td>{{ doc.driver || '—' }}</td>
          <td class="file-name" :title="doc.file_name">{{ doc.file_name }}</td>
          <td class="date">{{ fmtDate(doc.uploaded_at) }}</td>
          <td>
            <a :href="doc.drive_url" target="_blank" class="view-btn">View</a>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { useApi } from '../../composables/useApi'

const api = useApi()
const docs = ref([])
const loading = ref(false)
const activeFilter = ref('All')
const search = ref('')

const filters = ['All', 'POD', 'Receipt', 'Other']

const filtered = computed(() => {
  let list = docs.value
  if (activeFilter.value !== 'All') {
    if (activeFilter.value === 'Other') {
      list = list.filter(d => d.type !== 'POD' && d.type !== 'Receipt')
    } else {
      list = list.filter(d => d.type === activeFilter.value)
    }
  }
  const q = search.value.trim().toLowerCase()
  if (q) {
    list = list.filter(d =>
      (d.load_id || '').toLowerCase().includes(q) ||
      (d.driver || '').toLowerCase().includes(q) ||
      (d.file_name || '').toLowerCase().includes(q)
    )
  }
  return list
})

async function load() {
  loading.value = true
  try {
    const res = await api.get('/api/investor/documents')
    docs.value = res.documents || []
  } finally {
    loading.value = false
  }
}

function fmtDate(ts) {
  if (!ts) return '—'
  const d = new Date(ts)
  return isNaN(d) ? ts : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function typeClass(type) {
  if (type === 'POD') return 'type-pod'
  if (type === 'Receipt') return 'type-receipt'
  return 'type-other'
}

onMounted(load)
</script>

<style scoped>
.section {
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius); padding: 1.25rem; margin-bottom: 1.25rem;
}
.section-title {
  font-size: 0.95rem; font-weight: 700; margin-bottom: 1rem;
  display: flex; align-items: center; gap: 0.5rem;
}
.section-icon {
  width: 28px; height: 28px; border-radius: 8px;
  display: flex; align-items: center; justify-content: center; font-size: 0.9rem;
}
.doc-count {
  margin-left: auto; font-size: 0.68rem; font-weight: 600;
  padding: 0.2rem 0.55rem; border-radius: 8px;
  background: var(--blue-dim); color: var(--blue);
}

.filter-bar {
  display: flex; align-items: center; gap: 0.5rem; margin-bottom: 1rem; flex-wrap: wrap;
}
.filter-btn {
  padding: 0.3rem 0.75rem; border: 1px solid var(--border); border-radius: 20px;
  font-size: 0.72rem; font-weight: 600; font-family: inherit;
  background: var(--bg); color: var(--text-dim); cursor: pointer; transition: all 0.15s;
}
.filter-btn:hover { border-color: var(--blue); color: var(--blue); }
.filter-btn.active { background: var(--blue); border-color: var(--blue); color: #fff; }
.doc-search {
  margin-left: auto; padding: 0.3rem 0.7rem; border: 1px solid var(--border);
  border-radius: 6px; font-family: inherit; font-size: 0.78rem;
  background: var(--bg); color: var(--text); outline: none; min-width: 200px;
}
.doc-search:focus { border-color: var(--blue); }

.empty-state { text-align: center; color: var(--text-dim); font-size: 0.85rem; padding: 2rem 0; }

.doc-table {
  width: 100%; border-collapse: separate; border-spacing: 0; font-size: 0.82rem;
}
.doc-table th {
  text-align: left; padding: 0.6rem 0.5rem; font-weight: 600;
  color: var(--text-dim); border-bottom: 2px solid var(--border);
  font-size: 0.68rem; text-transform: uppercase; letter-spacing: 0.06em;
}
.doc-table td {
  padding: 0.6rem 0.5rem; border-bottom: 1px solid var(--bg); vertical-align: middle;
}
.doc-table tbody tr:hover { background: var(--bg); }

.mono { font-family: 'JetBrains Mono', monospace; font-size: 0.78rem; }
.file-name { max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-dim); font-size: 0.75rem; }
.date { font-size: 0.75rem; color: var(--text-dim); white-space: nowrap; }

.type-badge {
  display: inline-flex; padding: 0.2rem 0.55rem; border-radius: 10px;
  font-size: 0.65rem; font-weight: 700; font-family: 'JetBrains Mono', monospace;
  text-transform: uppercase;
}
.type-pod { background: var(--accent-dim); color: var(--accent); }
.type-receipt { background: var(--amber-dim); color: var(--amber); }
.type-other { background: var(--bg); color: var(--text-dim); }

.view-btn {
  padding: 0.25rem 0.65rem; border-radius: 5px; font-size: 0.72rem; font-weight: 600;
  background: var(--blue-dim); color: var(--blue); text-decoration: none; transition: opacity 0.15s;
}
.view-btn:hover { opacity: 0.75; }
</style>
