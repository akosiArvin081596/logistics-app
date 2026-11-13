<template>
  <!-- Who confirmed which "What's new" notice, and when, and the words drivers read: each notice's lines
       and its tour's steps, then the whole app tour once. Super Admin only, like the route behind it, and
       read only; nothing shows with the notices' kill switch off. -->
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
        <div v-if="notice.lines.length" class="dn-words" data-testid="driver-notice-lines">
          <h4 class="dn-words-heading">{{ RECORD_WORDS.lines }}</h4>
          <ul class="dn-lines">
            <li v-for="(line, i) in notice.lines" :key="i" data-testid="driver-notice-line">
              <span class="dn-text">{{ line.text }}</span>
              <span v-if="line.only" class="dn-only" data-testid="driver-notice-only">{{ line.only }}</span>
            </li>
          </ul>
        </div>
        <div v-if="notice.steps.length" class="dn-words" data-testid="driver-notice-tour">
          <h4 class="dn-words-heading">{{ RECORD_WORDS.tour }}</h4>
          <ol class="dn-steps">
            <li v-for="step in notice.steps" :key="step.id" data-testid="driver-tour-step">
              <span class="dn-step-title" data-testid="driver-tour-step-title">{{ step.title }}</span>
              <p v-for="(line, i) in step.lines" :key="i" class="dn-step-line" data-testid="driver-tour-step-line">
                <span class="dn-text">{{ line.text }}</span>
                <span v-if="line.only" class="dn-only" data-testid="driver-notice-only">{{ line.only }}</span>
              </p>
            </li>
          </ol>
        </div>
        <ul class="dn-rows">
          <li v-for="(row, i) in notice.rows" :key="i" class="dn-row" :class="`dn-${row.state}`" data-testid="driver-notice-row">
            <span class="dn-name">{{ row.name }}</span>
            <span class="dn-state">{{ row.text }}</span>
          </li>
        </ul>
      </CardContent>
    </Card>
    <Card v-if="state === 'shown' && appTour.length" class="dn-notice" data-testid="driver-app-tour">
      <CardContent class="dn-body">
        <div class="dn-head">
          <span class="dn-title" data-testid="driver-app-tour-title">{{ RECORD_WORDS.appTour }}</span>
        </div>
        <p class="dn-when">{{ RECORD_WORDS.appTourWhen }}</p>
        <ol class="dn-steps">
          <li v-for="step in appTour" :key="step.id" data-testid="driver-tour-step">
            <span class="dn-step-title" data-testid="driver-tour-step-title">{{ step.title }}</span>
            <p v-for="(line, i) in step.lines" :key="i" class="dn-step-line" data-testid="driver-tour-step-line">
              <span class="dn-text">{{ line.text }}</span>
              <span v-if="line.only" class="dn-only" data-testid="driver-notice-only">{{ line.only }}</span>
            </p>
          </li>
        </ol>
      </CardContent>
    </Card>
  </section>
</template>

<script setup>
import { onMounted, ref } from 'vue'
import { useApi } from '../../composables/useApi'
import { Card, CardContent } from '@/components/ui/card'
import { RECORD_URL, RECORD_WORDS, appTourView, recordView } from '../../lib/driverNoticeRecord'

const api = useApi()
// 'loading', 'shown', 'off' (the switch off, or not this role's) or 'unreadable'.
const state = ref('loading')
const notices = ref([])
// The app tour's words are the app's own, so they need no read; they show with the record.
const appTour = appTourView()

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
.dn-words { margin: 0 0 0.75rem; }
.dn-words-heading { margin: 0 0 0.3rem; font-size: 0.78rem; font-weight: 700; color: #475569; }
.dn-lines, .dn-steps { margin: 0; padding-left: 1.25rem; font-size: 0.85rem; line-height: 1.5; color: #334155; overflow-wrap: anywhere; }
.dn-lines { list-style: disc; }
.dn-steps { list-style: decimal; }
.dn-lines li, .dn-steps li { margin-bottom: 0.3rem; }
.dn-step-title { font-weight: 600; color: #0f172a; }
.dn-step-line { margin: 0.1rem 0 0; }
.dn-only { display: inline-block; margin-left: 0.4rem; padding: 0 0.45rem; border-radius: 999px; background: #eff6ff; color: #1d4ed8; font-size: 0.72rem; font-weight: 600; white-space: nowrap; }
.dn-when { margin: 0 0 0.6rem; font-size: 0.82rem; color: #64748b; }
.dn-rows { margin: 0; padding: 0; list-style: none; }
.dn-row { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 0.25rem 1rem; padding: 0.45rem 0; border-top: 1px solid #e2e8f0; font-size: 0.85rem; overflow-wrap: anywhere; }
.dn-name { font-weight: 600; }
.dn-state { color: #475569; }
.dn-acknowledged .dn-state { color: #047857; }
.dn-not-yet .dn-state { color: #b45309; }
</style>
