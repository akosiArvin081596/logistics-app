<template>
  <div class="preview-shell">
    <!-- Checking that the id names an investor account. No part of the portal
         (banner, InvestorView, its sections' requests) renders until it does. -->
    <div v-if="status === 'checking'" role="status" aria-busy="true">
      <span class="sr-only">Checking the investor account</span>
      <div class="skeleton skeleton-block"></div>
      <div class="skeleton skeleton-block"></div>
    </div>

    <section
      v-else-if="status === 'not-found' || status === 'error'"
      class="preview-missing"
      :role="status === 'error' ? 'alert' : null"
      aria-labelledby="preview-missing-title"
    >
      <h2 id="preview-missing-title" class="missing-title">
        {{ status === 'error' ? 'Could not open this preview' : 'Investor not found' }}
      </h2>
      <p v-if="status === 'not-found'" class="missing-text">
        No investor account has the id <span class="missing-id">{{ route.params.userId }}</span>,
        so there is no portal to preview.
      </p>
      <template v-else>
        <p class="missing-text" :class="{ 'missing-text-tight': checkError }">
          The account list did not load, so this link could not be checked.
        </p>
        <p v-if="checkError" class="missing-detail">{{ checkError }}</p>
      </template>
      <div class="missing-actions">
        <button v-if="status === 'error'" type="button" class="btn btn-primary" @click="activate">
          Try again
        </button>
        <router-link :to="{ name: 'investor-portals' }" class="btn btn-secondary missing-back">
          &larr; Back to Investor Portals
        </router-link>
      </div>
    </section>

    <template v-else>
      <div class="preview-banner">
        <div class="banner-left">
          <span class="banner-eye">&#128065;</span>
          <div class="banner-text">
            <div class="banner-title">
              Previewing <strong>{{ targetName || 'investor' }}</strong>'s portal
            </div>
            <div class="banner-sub">Read-only replica &middot; the investor is not affected by anything you do here</div>
          </div>
        </div>
        <button class="banner-exit" @click="exit">&larr; Exit Preview</button>
      </div>
      <!-- :key forces a fresh mount of InvestorView when the previewed userId
           changes, so its onMounted loadData() fires for every investor.
           Without this, switching from /investor-portals/1 to /investor-portals/2
           would leave the dashboard stuck on the first investor's trucks. -->
      <InvestorView :key="route.params.userId" />
    </template>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useRoute, useRouter, onBeforeRouteLeave } from 'vue-router'
import { useInvestorStore } from '../stores/investor'
import { useApi } from '../composables/useApi'
import InvestorView from './InvestorView.vue'

const route = useRoute()
const router = useRouter()
const store = useInvestorStore()
const api = useApi()

const targetName = computed(() => store.data?.investor?.fullName || store.data?.investor?.username || '')

// 'checking' | 'found' | 'not-found' | 'error'. InvestorView mounts only on
// 'found', so a link to anyone but an investor loads no portal section at all.
const status = ref('checking')
const checkError = ref('')
// Each activation owns one check; an answer for an id the page has already
// left (the URL changed while it was in flight) is dropped.
let checkSeq = 0

// The route param as a users.id, or null. Digits only: parseInt would read
// "12abc" as 12 and preview someone the URL does not name.
function previewId(raw) {
  const s = String(raw ?? '')
  return /^[1-9]\d{0,14}$/.test(s) ? parseInt(s, 10) : null
}

async function activate() {
  const seq = ++checkSeq
  const id = previewId(route.params.userId)
  checkError.value = ''
  if (id == null) {
    store.clearPreview()
    status.value = 'not-found'
    return
  }
  status.value = 'checking'
  store.setPreview(id)
  try {
    // The server previews an account only when users.role is exactly
    // 'Investor' (resolvePreviewUser in server.js), so that is the test here.
    // GET /api/users is one SQLite read; GET /api/investor?as_user_id= would
    // answer the same question only after building the whole dashboard, which
    // InvestorView then builds again.
    const { users } = await api.get('/api/users')
    if (seq !== checkSeq) return
    const isInvestor = (users || []).some((u) => u.id === id && u.Role === 'Investor')
    if (!isInvestor) store.clearPreview()
    status.value = isInvestor ? 'found' : 'not-found'
  } catch (err) {
    if (seq !== checkSeq) return
    checkError.value = err.message || ''
    status.value = 'error'
  }
}

function exit() {
  router.push({ name: 'investor-portals' })
}

// Activate IMMEDIATELY at script-setup time. setPreview() must run before
// InvestorView mounts, or its onMounted loadData() requests the admin's own
// fleet-wide /investor data instead of the previewed investor's. InvestorView
// now mounts only once the check says 'found', which is after setPreview().
activate()

// Re-activate when the userId param changes (user edits the URL or navigates
// between two preview routes). 'checking' unmounts the previous InvestorView,
// and its :key on userId makes the next one a fresh mount that re-runs
// onMounted's loadData(). A change that leaves this route is not a new preview.
watch(() => route.params.userId, (next, prev) => {
  if (next !== prev && route.name === 'investor-portal-preview') activate()
})

onBeforeRouteLeave(() => {
  store.clearPreview()
})
onBeforeUnmount(() => {
  store.clearPreview()
})
</script>

<style scoped>
.preview-shell { padding-top: 0.5rem; }

.skeleton-block {
  height: 200px;
  margin-bottom: 1rem;
  border-radius: var(--radius);
}

.preview-missing {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 2rem 1.5rem;
  text-align: center;
}
.missing-title {
  font-size: 1.1rem;
  font-weight: 800;
  margin: 0 0 0.5rem;
}
.missing-text {
  font-size: 0.85rem;
  color: var(--text-dim);
  line-height: 1.5;
  max-width: 520px;
  margin: 0 auto 1.25rem;
}
.missing-text-tight { margin-bottom: 0.35rem; }
.missing-detail {
  font-size: 0.75rem;
  color: var(--text-dim);
  margin: 0 auto 1.25rem;
  overflow-wrap: anywhere;
}
.missing-id {
  font-family: 'JetBrains Mono', monospace;
  font-weight: 700;
  color: var(--text);
  overflow-wrap: anywhere;
}
.missing-actions {
  display: flex;
  justify-content: center;
  gap: 0.5rem;
  flex-wrap: wrap;
}
.missing-back {
  display: inline-block;
  text-decoration: none;
}

.preview-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  background: linear-gradient(90deg, #fef3c7, #fde68a);
  border: 1px solid #f59e0b;
  border-radius: 10px;
  padding: 0.7rem 1rem;
  margin-bottom: 1rem;
  color: #78350f;
  flex-wrap: wrap;
}
.banner-left {
  display: flex;
  align-items: center;
  gap: 0.65rem;
  min-width: 0;
  flex: 1;
}
.banner-eye {
  font-size: 1.4rem;
  line-height: 1;
}
.banner-text { min-width: 0; }
.banner-title {
  font-size: 0.92rem;
  font-weight: 600;
  line-height: 1.25;
  color: #78350f;
}
.banner-title strong {
  font-weight: 800;
  color: #451a03;
}
.banner-sub {
  font-size: 0.74rem;
  color: #92400e;
  margin-top: 0.15rem;
  line-height: 1.3;
}

.banner-exit {
  padding: 0.5rem 1rem;
  background: #fff;
  color: #78350f;
  border: 1px solid #f59e0b;
  border-radius: 6px;
  font-size: 0.82rem;
  font-weight: 700;
  font-family: inherit;
  cursor: pointer;
  white-space: nowrap;
  transition: all 0.15s;
}
.banner-exit:hover { background: #fef3c7; color: #451a03; }

@media (max-width: 600px) {
  .preview-banner { padding: 0.6rem 0.75rem; }
  .banner-title { font-size: 0.85rem; }
  .banner-sub { font-size: 0.7rem; }
  .banner-exit { padding: 0.4rem 0.7rem; font-size: 0.75rem; }
}
</style>
