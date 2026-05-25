<template>
  <div class="admin-page portals-page">
    <div class="page-header">
      <h2>Investor Portals</h2>
      <p class="page-sub">
        Open a read-only replica of any investor's portal to verify what they see — no need to ask them to log in or send a screenshot.
      </p>
    </div>

    <div class="toolbar">
      <input
        v-model="search"
        type="text"
        class="search-input"
        placeholder="Search by name..."
        autocomplete="off"
      />
      <span class="result-count">
        {{ filtered.length }} {{ filtered.length === 1 ? 'investor' : 'investors' }}
      </span>
    </div>

    <SkeletonLoader v-if="loading" :rows="3" :cols="4" />
    <template v-else>
      <div v-if="filtered.length === 0" class="empty">
        <template v-if="investors.length === 0">No investors on file yet.</template>
        <template v-else>No investors match "{{ search }}".</template>
      </div>
      <div v-else class="card-grid">
        <article
          v-for="inv in filtered"
          :key="inv.id"
          class="investor-card"
          :class="{ 'card-disabled': !inv.userId }"
        >
          <header class="card-head">
            <div class="card-avatar">
              <img v-if="inv.profilePictureUrl" :src="inv.profilePictureUrl" :alt="inv.fullName" />
              <span v-else class="card-initials">{{ initials(inv.fullName) }}</span>
            </div>
            <div class="card-identity">
              <h3 class="card-name">{{ inv.fullName }}</h3>
            </div>
          </header>

          <div class="card-stats">
            <div class="stat">
              <div class="stat-label">Status</div>
              <span :class="['status-pill', inv.status === 'Active' ? 'pill-green' : 'pill-gray']">
                {{ inv.status || 'Inactive' }}
              </span>
            </div>
            <div class="stat">
              <div class="stat-label">Trucks</div>
              <div class="stat-value">{{ inv.truckCount }}</div>
            </div>
            <div class="stat">
              <div class="stat-label">Portal Access</div>
              <span :class="['status-pill', inv.userId ? 'pill-blue' : 'pill-gray']">
                {{ inv.userId ? 'Linked' : 'No login' }}
              </span>
            </div>
          </div>

          <div class="card-actions">
            <router-link
              v-if="inv.userId"
              :to="{ name: 'investor-portal-preview', params: { userId: inv.userId } }"
              class="btn-view"
            >
              View Portal &rarr;
            </router-link>
            <button v-else class="btn-disabled" disabled title="This investor has no linked user account">
              No portal available
            </button>
          </div>
        </article>
      </div>
    </template>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { useApi } from '../composables/useApi'
import { useToast } from '../composables/useToast'
import SkeletonLoader from '../components/shared/SkeletonLoader.vue'

const api = useApi()
const { show: toast } = useToast()

const investors = ref([])
const loading = ref(true)
const search = ref('')

const filtered = computed(() => {
  const q = search.value.trim().toLowerCase()
  if (!q) return investors.value
  return investors.value.filter(i =>
    (i.fullName || '').toLowerCase().includes(q) ||
    (i.username || '').toLowerCase().includes(q)
  )
})

function initials(name) {
  return (name || '?')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map(s => s[0].toUpperCase())
    .join('')
}

onMounted(async () => {
  try {
    const res = await api.get('/api/investors')
    investors.value = res.investors || []
  } catch (err) {
    toast(err.message || 'Failed to load investors', 'error')
  } finally {
    loading.value = false
  }
})
</script>

<style scoped>
.portals-page { padding-bottom: 4rem; }
.page-header { margin-bottom: 1.25rem; }
.page-header h2 {
  font-size: 1.35rem;
  font-weight: 800;
  letter-spacing: -0.01em;
  margin: 0 0 0.25rem;
}
.page-sub {
  font-size: 0.85rem;
  color: var(--text-dim);
  max-width: 720px;
  line-height: 1.45;
  margin: 0;
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  margin-bottom: 1rem;
  flex-wrap: wrap;
}
.search-input {
  flex: 1;
  min-width: 200px;
  max-width: 420px;
  padding: 0.55rem 0.85rem;
  font-size: 0.88rem;
  font-family: inherit;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  color: var(--text);
  outline: none;
  transition: border-color 0.15s;
}
.search-input:focus { border-color: var(--accent); }
.result-count {
  font-size: 0.78rem;
  font-weight: 600;
  color: var(--text-dim);
  font-family: 'JetBrains Mono', monospace;
}

.empty {
  padding: 3rem 1rem;
  text-align: center;
  background: var(--surface);
  border: 1px dashed var(--border);
  border-radius: var(--radius);
  color: var(--text-dim);
  font-size: 0.9rem;
}

.card-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 1rem;
}

.investor-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 1.1rem 1.15rem;
  display: flex;
  flex-direction: column;
  gap: 0.85rem;
  transition: border-color 0.15s, box-shadow 0.15s, transform 0.15s;
}
.investor-card:hover:not(.card-disabled) {
  border-color: var(--accent);
  box-shadow: 0 4px 14px rgba(0,0,0,0.06);
  transform: translateY(-1px);
}
.card-disabled { opacity: 0.65; }

.card-head {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}
.card-avatar {
  width: 44px;
  height: 44px;
  border-radius: 50%;
  background: var(--bg);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  overflow: hidden;
  border: 1px solid var(--border);
}
.card-avatar img { width: 100%; height: 100%; object-fit: cover; display: block; }
.card-initials {
  font-size: 0.95rem;
  font-weight: 700;
  color: var(--text-dim);
  font-family: 'JetBrains Mono', monospace;
}

.card-identity { min-width: 0; flex: 1; }
.card-name {
  font-size: 0.95rem;
  font-weight: 700;
  margin: 0;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.card-stats {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
  gap: 0.4rem;
  padding: 0.6rem 0;
  border-top: 1px solid var(--bg);
  border-bottom: 1px solid var(--bg);
}
.stat { display: flex; flex-direction: column; align-items: flex-start; gap: 0.2rem; min-width: 0; }
.stat-label {
  font-size: 0.62rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-dim);
}
.stat-value {
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.95rem;
  font-weight: 700;
  color: var(--text);
}

.status-pill {
  font-size: 0.68rem;
  font-weight: 700;
  padding: 0.15rem 0.5rem;
  border-radius: 99px;
  white-space: nowrap;
}
.pill-green { background: #d1fae5; color: #065f46; }
.pill-blue { background: #dbeafe; color: #1e40af; }
.pill-gray { background: #f3f4f6; color: #6b7280; }

.card-actions { display: flex; }
.btn-view {
  flex: 1;
  text-align: center;
  padding: 0.55rem 0.9rem;
  background: var(--accent);
  color: #fff;
  border-radius: 8px;
  text-decoration: none;
  font-weight: 700;
  font-size: 0.82rem;
  transition: opacity 0.15s;
}
.btn-view:hover { opacity: 0.9; }
.btn-disabled {
  flex: 1;
  padding: 0.55rem 0.9rem;
  background: var(--bg);
  color: var(--text-dim);
  border: 1px dashed var(--border);
  border-radius: 8px;
  font-weight: 600;
  font-size: 0.82rem;
  font-family: inherit;
  cursor: not-allowed;
}

@media (max-width: 600px) {
  .card-grid { grid-template-columns: 1fr; }
}
</style>
