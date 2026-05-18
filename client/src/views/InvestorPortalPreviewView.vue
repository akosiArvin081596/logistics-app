<template>
  <div class="preview-shell">
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
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, watch } from 'vue'
import { useRoute, useRouter, onBeforeRouteLeave } from 'vue-router'
import { useInvestorStore } from '../stores/investor'
import InvestorView from './InvestorView.vue'

const route = useRoute()
const router = useRouter()
const store = useInvestorStore()

const targetName = computed(() => store.data?.investor?.fullName || store.data?.investor?.username || '')

function activate() {
  const id = parseInt(route.params.userId, 10)
  if (Number.isFinite(id) && id > 0) {
    store.setPreview(id)
  }
}

function exit() {
  router.push({ name: 'investor-portals' })
}

// Activate IMMEDIATELY at script-setup time (before InvestorView mounts).
// Children mount before parents in Vue, so if we deferred to onMounted the
// child's loadData() would fire first with previewUserId=null and request
// the admin's own /investor data instead of the previewed investor's.
activate()

// Re-activate when the userId param changes (user edits the URL or navigates
// between two preview routes). InvestorView is given a :key on userId in the
// template so it fully remounts and re-runs onMounted's loadData().
watch(() => route.params.userId, (next, prev) => {
  if (next !== prev) activate()
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
