<!--
  The C.H. Robinson badge in a load's detail (dispatch Active and Completed
  Loads). Super Admin only, like the rate-con tile; the server is the gate.
  GET /api/integrations/chr/status is read once per session, and a load's
  summary is asked for only while the feature is on, so opening a load costs
  no request while it is off. A load with no CHR updates shows nothing.
-->
<template>
  <router-link v-if="badge" :to="link" class="chr-badge" :class="`chr-badge--${badge.tone}`" :title="'Open this load on the C.H. Robinson page'">
    {{ badge.text }}
  </router-link>
</template>

<script>
// One status read shared by every badge in this session.
let statusOnce = null
</script>

<script setup>
import { ref, computed, watch } from 'vue'
import { useAuthStore } from '../../stores/auth'
import { useApi } from '../../composables/useApi'
import { showChrBadge, shouldAskLoadSummary, badgeFor, pageLinkForLoad, loadSummaryUrl, CHR_API } from '../../lib/chrIntegration.js'

const props = defineProps({
  loadId: { type: String, default: '' },
  // The modal owns visibility: nothing is fetched for a closed modal.
  open: { type: Boolean, default: false },
})

const auth = useAuthStore()
const api = useApi()
const summary = ref(null)
const visible = computed(() => showChrBadge(auth.user?.role))
const badge = computed(() => (visible.value ? badgeFor(summary.value) : null))
const link = computed(() => pageLinkForLoad(props.loadId))

function featureStatus() {
  if (!statusOnce) {
    statusOnce = api.get(`${CHR_API}/status`).catch(() => {
      statusOnce = null
      return null
    })
  }
  return statusOnce
}

let seq = 0
async function load(id) {
  const mine = ++seq
  summary.value = null
  if (!visible.value || !id) return
  const status = await featureStatus()
  if (mine !== seq || !shouldAskLoadSummary(status)) return
  try {
    const s = await api.get(loadSummaryUrl(id))
    if (mine === seq) summary.value = s
  } catch {
    // A 404 means no CHR updates for this load; any other failure shows no badge.
  }
}

watch(() => [props.loadId, props.open], ([id, open]) => {
  if (open) load(id)
  else {
    seq++
    summary.value = null
  }
}, { immediate: true })
</script>

<style scoped>
.chr-badge {
  display: inline-flex;
  align-items: center;
  margin: 0.25rem 0 0.5rem;
  padding: 0.2rem 0.55rem;
  border-radius: 999px;
  font-size: 0.74rem;
  font-weight: 600;
  text-decoration: none;
  border: 1px solid var(--border);
  color: var(--text);
  background: var(--surface, #fff);
}
.chr-badge--live { border-color: #86efac; background: #f0fdf4; color: #166534; }
.chr-badge--dry { border-color: #93c5fd; background: #eff6ff; color: #1e40af; }
.chr-badge--warn { border-color: #fcd34d; background: #fffbeb; color: #92400e; }
.chr-badge--bad { border-color: #fca5a5; background: #fef2f2; color: #991b1b; }
.chr-badge--muted { color: var(--text-dim); }
</style>
