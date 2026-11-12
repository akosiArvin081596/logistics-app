<template>
  <!-- Who confirmed which "What's new" notice, and when. Super Admin only, like the route behind it;
       nothing shows with the notices' kill switch off. -->
  <section v-if="state === 'shown' || state === 'unreadable'" class="driver-notices" data-testid="driver-notices">
    <h3 class="dn-heading">{{ RECORD_WORDS.heading }}</h3>
    <p v-if="state === 'unreadable'" class="dn-unreadable" data-testid="driver-notices-unreadable">{{ RECORD_WORDS.unreadable }}</p>
    <Card v-for="notice in notices" :key="notice.id" class="dn-notice" data-testid="driver-notice">
      <CardContent class="dn-body">
        <div class="dn-head">
          <span class="dn-title" data-testid="driver-notice-title">{{ notice.title }}</span>
          <span v-if="notice.date" class="dn-date">{{ notice.date }}</span>
          <span class="dn-count" data-testid="driver-notice-count">{{ notice.count }}</span>
        </div>
        <ul class="dn-rows">
          <li v-for="(row, i) in notice.rows" :key="i" class="dn-row" :class="`dn-${row.state}`" data-testid="driver-notice-row">
            <span class="dn-name">{{ row.name }}</span>
            <span class="dn-state">{{ row.text }}</span>
          </li>
        </ul>
      </CardContent>
    </Card>
  </section>
</template>

<script setup>
import { onMounted, ref } from 'vue'
import { useApi } from '../../composables/useApi'
import { Card, CardContent } from '@/components/ui/card'
import { RECORD_URL, RECORD_WORDS, recordView } from '../../lib/driverNoticeRecord'

const api = useApi()
// 'loading', 'shown', 'off' (the switch off, or not this role's) or 'unreadable'.
const state = ref('loading')
const notices = ref([])

onMounted(async () => {
  try {
    const view = recordView(await api.get(RECORD_URL))
    if (!view) {
      state.value = 'unreadable'
      return
    }
    notices.value = view
    state.value = 'shown'
  } catch (err) {
    state.value = err && (err.status === 404 || err.status === 403) ? 'off' : 'unreadable'
  }
})
</script>

<style scoped>
.driver-notices { margin-top: 1.5rem; }
.dn-heading { margin: 0 0 0.75rem; font-size: 1rem; font-weight: 700; }
.dn-unreadable { margin: 0; font-size: 0.85rem; color: #b91c1c; }
.dn-notice { margin-bottom: 1rem; }
.dn-body { padding: 1rem 1.25rem; }
.dn-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.25rem 0.75rem; margin-bottom: 0.6rem; }
.dn-title { font-weight: 700; }
.dn-date { font-size: 0.82rem; color: #64748b; }
.dn-count { margin-left: auto; font-size: 0.85rem; font-weight: 600; }
.dn-rows { margin: 0; padding: 0; list-style: none; }
.dn-row { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 0.25rem 1rem; padding: 0.45rem 0; border-top: 1px solid #e2e8f0; font-size: 0.85rem; overflow-wrap: anywhere; }
.dn-name { font-weight: 600; }
.dn-state { color: #475569; }
.dn-acknowledged .dn-state { color: #047857; }
.dn-not-yet .dn-state { color: #b45309; }
</style>
