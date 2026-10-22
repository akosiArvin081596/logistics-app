<template>
  <div class="deleted-loads-page admin-page" style="overflow-y:auto;min-height:auto;flex:none;">
    <div class="page-header dl-header">
      <div class="dl-heading">
        <h2>Deleted loads</h2>
        <p class="dl-desc">Loads deleted from the dashboard, newest first. Month is the load's settlement month; Closed says whether that month is closed. This page is a list only.</p>
      </div>
      <router-link :to="{ name: 'dashboard' }" class="dl-back">Back to the dashboard</router-link>
    </div>

    <SkeletonLoader v-if="loading && !loaded" :rows="4" :cols="7" />
    <div v-else-if="!loaded && error" class="load-error" role="alert">
      <span>{{ error }}</span>
      <button type="button" class="btn btn-secondary btn-sm" @click="load">Retry</button>
    </div>
    <template v-else>
      <p v-if="error" class="load-error" role="alert">
        <span>{{ error }} These are the deleted loads as last loaded.</span>
        <button type="button" class="btn btn-secondary btn-sm" @click="load">Retry</button>
      </p>

      <EmptyState v-if="!loads.length">No deleted loads.</EmptyState>

      <!-- Phone: one card per deleted load, every field labelled. -->
      <ul v-else-if="isMobile" class="dl-cards" aria-label="Deleted loads">
        <li v-for="l in loads" :key="l.id" class="dl-card">
          <div class="dl-card-id">{{ l.loadId || '—' }}</div>
          <dl class="dl-fields">
            <div class="dl-field"><dt>Route</dt><dd>{{ deletedLoadRoute(l) }}</dd></div>
            <div class="dl-field"><dt>Driver</dt><dd>{{ l.driver || '—' }}</dd></div>
            <div class="dl-field"><dt>Deleted</dt><dd>{{ fmtAppInstant(l.deletedAt) }}</dd></div>
            <div class="dl-field"><dt>Deleted by</dt><dd>{{ l.deletedBy || '—' }}</dd></div>
            <div class="dl-field">
              <dt>Month</dt>
              <dd>
                <span v-if="!l.months.length">—</span>
                <span v-for="m in deletedLoadMonths(l)" :key="m.key" class="dl-month-line">
                  {{ m.label }} · Closed: <span :class="m.closed ? 'dl-closed' : 'dl-open'">{{ m.closedText }}</span>
                </span>
                <span v-if="deletedLoadMonthsNote(l)" class="dl-note">{{ deletedLoadMonthsNote(l) }}</span>
              </dd>
            </div>
          </dl>
        </li>
      </ul>

      <Table v-else>
        <TableHeader>
          <TableRow>
            <TableHead>Load ID</TableHead>
            <TableHead>Route</TableHead>
            <TableHead>Driver</TableHead>
            <TableHead>Date deleted</TableHead>
            <TableHead>Deleted by</TableHead>
            <TableHead>Month</TableHead>
            <TableHead>Closed</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow v-for="l in loads" :key="l.id" class="dl-row">
            <TableCell class="dl-id">{{ l.loadId || '—' }}</TableCell>
            <TableCell>{{ deletedLoadRoute(l) }}</TableCell>
            <TableCell>{{ l.driver || '—' }}</TableCell>
            <TableCell class="dl-nowrap">{{ fmtAppInstant(l.deletedAt) }}</TableCell>
            <TableCell>{{ l.deletedBy || '—' }}</TableCell>
            <TableCell class="dl-nowrap">
              <span v-if="!l.months.length">—</span>
              <span v-for="m in deletedLoadMonths(l)" :key="m.key" class="dl-month-line">{{ m.label }}</span>
              <span v-if="deletedLoadMonthsNote(l)" class="dl-note">{{ deletedLoadMonthsNote(l) }}</span>
            </TableCell>
            <TableCell>
              <span v-if="!l.months.length">—</span>
              <span v-for="m in deletedLoadMonths(l)" :key="m.key" class="dl-month-line" :class="m.closed ? 'dl-closed' : 'dl-open'">{{ m.closedText }}</span>
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </template>
  </div>
</template>

<script setup>
import { ref } from 'vue'
import { useApi } from '../composables/useApi'
import { useSocketRefresh } from '../composables/useSocketRefresh'
import { useViewport } from '../composables/useViewport'
import { fmtAppInstant } from '../utils/datetime'
import { deletedLoadRoute, deletedLoadMonths, deletedLoadMonthsNote, deletedLoadsErrorText } from '../lib/deletedLoadsView.js'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import SkeletonLoader from '../components/shared/SkeletonLoader.vue'
import EmptyState from '../components/shared/EmptyState.vue'

// GET /api/admin/deleted-loads as the server sent it. Super Admin only (router
// meta and requireRole on the route). A list only: nothing here restores a load.
// Rows are keyed on deleted_loads' own id: a load deleted twice in the same
// second has two rows alike in every other field.
const api = useApi()
const { isMobile } = useViewport()
const loads = ref([])
const loading = ref(false)
const loaded = ref(false)
const error = ref('')

async function load() {
  loading.value = true
  try {
    const res = await api.get('/api/admin/deleted-loads')
    loads.value = Array.isArray(res.loads) ? res.loads : []
    loaded.value = true
    error.value = ''
  } catch (err) {
    error.value = deletedLoadsErrorText(err)
  } finally {
    loading.value = false
  }
}

// A delete anywhere announces dashboard:changed.
useSocketRefresh('dashboard:changed', () => load())
load()
</script>

<style scoped>
.dl-header { align-items: flex-start; }
.dl-heading { min-width: 0; }
.dl-desc {
  margin: 0.25rem 0 0;
  font-size: 0.82rem;
  color: var(--text-dim);
}
.dl-back {
  font-size: 0.82rem;
  font-weight: 600;
  color: var(--accent);
  text-decoration: none;
}
.dl-back:hover, .dl-back:focus-visible { text-decoration: underline; }
.dl-id { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.8rem; word-break: break-all; }
.dl-nowrap { white-space: nowrap; }
/* A load with two months lists them on two lines; the row's cells start level. */
.dl-row > td { vertical-align: top; }
.dl-month-line { display: block; }
.dl-closed { color: #b91c1c; font-weight: 600; }
.dl-open { color: #15803d; font-weight: 600; }
.dl-note { display: block; font-size: 0.72rem; color: var(--text-dim); font-style: italic; }
.dl-cards {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}
.dl-card {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  padding: 0.85rem 1rem;
  min-width: 0;
}
.dl-card-id {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-weight: 700;
  font-size: 0.9rem;
  margin-bottom: 0.5rem;
  overflow-wrap: anywhere;
}
.dl-fields { margin: 0; display: flex; flex-direction: column; gap: 0.35rem; }
.dl-field { display: grid; grid-template-columns: 5.5rem minmax(0, 1fr); gap: 0.5rem; font-size: 0.82rem; }
.dl-field dt { color: var(--text-dim); font-weight: 600; }
.dl-field dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
.load-error {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  margin: 0 0 1rem;
  padding: 0.6rem 0.85rem;
  border-radius: var(--radius);
  background: var(--danger-dim);
  color: #b91c1c;
  font-size: 0.8rem;
}
</style>
