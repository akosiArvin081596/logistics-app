<template>
  <router-link v-if="visible" :to="{ name: 'admin-deleted-loads' }" class="deleted-loads-link">
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /><path d="M10 11v6" /><path d="M14 11v6" /><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" /></svg>
    {{ deletedLoadsLinkText(count) }}
  </router-link>
</template>

<script setup>
import { computed, ref } from 'vue'
import { useApi } from '../../composables/useApi'
import { useSocketRefresh } from '../../composables/useSocketRefresh'
import { useAuthStore } from '../../stores/auth'
import { canSeeDeletedLoads, deletedLoadsLinkText } from '../../lib/deletedLoadsView.js'

// "Deleted loads (N)" on Active Loads, for Super Admins only. N is the length
// of GET /api/admin/deleted-loads; while it is unknown (loading, or the list
// could not be read) the link reads "Deleted loads". Any other role renders
// nothing and asks the server nothing; the server's role gate is the real one.
const auth = useAuthStore()
const api = useApi()
const visible = computed(() => canSeeDeletedLoads(auth.user?.role))
const count = ref(null)

async function loadCount() {
  if (!visible.value) return
  try {
    const res = await api.get('/api/admin/deleted-loads')
    count.value = Number.isInteger(res.count) ? res.count : null
  } catch {
    count.value = null
  }
}

// A delete announces dashboard:changed.
useSocketRefresh('dashboard:changed', () => loadCount())
loadCount()
</script>

<style scoped>
.deleted-loads-link {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.35rem 0.7rem;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg);
  color: var(--text-dim);
  font-size: 0.78rem;
  font-weight: 600;
  text-decoration: none;
  white-space: nowrap;
}
.deleted-loads-link:hover,
.deleted-loads-link:focus-visible {
  border-color: var(--accent);
  color: var(--accent);
}
</style>
