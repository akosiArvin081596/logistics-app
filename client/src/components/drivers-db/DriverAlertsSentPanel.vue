<template>
  <!-- What the driver's Alerts tab lists, read-only, on the Drivers page's detail dialog.
       The server decides who sees it (Super Admin): nothing shows until it answers, nor
       for a 403 or a 404. -->
  <section v-if="view" class="asp" aria-label="Alerts sent" data-testid="alerts-sent">
    <h4 class="asp-title">{{ ALERTS_WORDS.heading }}</h4>
    <p v-if="view.note" class="asp-muted" data-testid="alerts-sent-note">{{ view.note }}</p>
    <template v-else>
      <p v-if="view.newest" class="asp-muted" data-testid="alerts-sent-newest">{{ view.newest }}</p>
      <ul class="asp-list">
        <li v-for="(row, i) in view.rows" :key="i" class="asp-row" data-testid="alerts-sent-row">
          <span class="asp-row-title">{{ row.title }}</span>
          <span v-if="row.text" class="asp-row-text">{{ row.text }}</span>
          <span v-if="row.time" class="asp-row-time">{{ row.time }}</span>
        </li>
      </ul>
    </template>
  </section>
</template>

<script setup>
import { onUnmounted, ref, watch } from 'vue'
import { useApi } from '../../composables/useApi'
import { ALERTS_WORDS, alertsSentUrl, alertsSentView, isHiddenAnswer } from '../../lib/driverAlertsSent'

const props = defineProps({
  directoryId: { type: Number, default: null },
})

const api = useApi()
const view = ref(null)
// Moved on by every row change and by unmounting: a late answer is dropped.
let seq = 0

async function load() {
  const mine = ++seq
  view.value = null
  const url = alertsSentUrl(props.directoryId)
  if (!url) return
  try {
    const answer = await api.get(url)
    if (mine === seq) view.value = alertsSentView(answer)
  } catch (err) {
    if (mine === seq) view.value = isHiddenAnswer(err) ? null : alertsSentView(null)
  }
}

watch(() => props.directoryId, load, { immediate: true })
onUnmounted(() => { seq++ })
</script>

<style scoped>
.asp { margin-top: 1.25rem; padding-top: 1rem; border-top: 1px solid #e8edf2; }
.asp-title { font-size: 0.72rem; font-weight: 700; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.05em; margin: 0 0 0.6rem; }
.asp-muted { font-size: 0.78rem; color: #6b7280; margin: 0 0 0.5rem; }
/* Up to 100 rows: the list scrolls inside the dialog rather than stretching it. */
.asp-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.35rem; max-height: 22rem; overflow-y: auto; }
.asp-row { display: flex; flex-direction: column; gap: 0.15rem; padding: 0.55rem 0.75rem; background: #fafbfd; border: 1px solid #f1f5f9; border-radius: 8px; min-width: 0; }
.asp-row-title { font-size: 0.82rem; font-weight: 600; color: #0f172a; overflow-wrap: anywhere; }
.asp-row-text { font-size: 0.78rem; color: #475569; white-space: pre-wrap; overflow-wrap: anywhere; }
.asp-row-time { font-size: 0.7rem; color: #64748b; }
</style>
