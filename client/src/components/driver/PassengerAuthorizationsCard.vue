<template>
  <!-- A Driver's own passenger authorizations: optional, on the onboarding screen
       (compact) and in the Kit. Nothing shows unless the server's feature route says
       PASSENGER_AUTHORIZATION_ENABLED is on. -->
  <section v-if="shown" class="card pac-card" :class="{ 'pac-compact': compact }" :aria-labelledby="titleId" data-testid="pa-card">
    <div class="pac-header">
      <div class="pac-icon" aria-hidden="true">&#128101;</div>
      <h3 :id="titleId" class="pac-title">Passenger authorization</h3>
      <span v-if="compact" class="pac-optional">Optional</span>
      <button v-if="compact && collapsed" type="button" class="pac-show" data-testid="pa-show" @click="setCollapsed(false)">Show</button>
    </div>

    <template v-if="!(compact && collapsed)">
      <p class="pac-intro">
        Taking a passenger in the truck? The passenger, or a parent or guardian for anyone under 18, signs a passenger
        authorization and accident waiver with you on this phone. It is valid once LogisX Inc. signs it.
      </p>
      <p v-if="compact" class="pac-intro">It's optional: skipping it doesn't hold up your onboarding.</p>

      <p v-if="loading" class="pac-empty">Loading&hellip;</p>
      <div v-else-if="loadError" class="pac-empty" role="alert">
        <span>{{ loadError }}</span>
        <button type="button" class="pac-link" @click="load">Try again</button>
      </div>
      <template v-else>
        <ul v-if="rows.length" class="pac-list">
          <li v-for="row in rows" :key="row.id" class="pac-row" data-testid="pa-row">
            <div class="pac-row-top">
              <span class="pac-name">{{ row.passengerName }}</span>
              <span v-if="row.minor" class="pac-tag">Under 18</span>
            </div>
            <span :class="['pac-status', `pac-${row.status.tone}`]" data-testid="pa-status">{{ row.status.text }}</span>
            <div class="pac-trip">{{ row.tripStart }} to {{ row.tripEnd }}</div>
            <div class="pac-meta">
              <span v-if="row.dates">{{ row.dates }}</span>
              <span v-if="row.reference">{{ row.reference }}</span>
            </div>
            <a v-if="row.pdfUrl" :href="row.pdfUrl" target="_blank" rel="noopener" class="pac-link">Open PDF</a>
          </li>
        </ul>
        <p v-else-if="!compact" class="pac-empty" data-testid="pa-empty">No passenger authorizations yet.</p>
      </template>

      <div class="pac-actions">
        <button type="button" class="pac-btn pac-primary" data-testid="pa-new" @click="showModal = true">
          {{ compact ? 'Add a passenger' : 'New passenger authorization' }}
        </button>
        <button v-if="compact" type="button" class="pac-btn pac-ghost" data-testid="pa-not-now" @click="setCollapsed(true)">Not now</button>
      </div>
    </template>

    <PassengerAuthorizationModal
      :show="showModal"
      :driver-name="driverName"
      :truck-unit="truckUnit"
      @close="showModal = false"
      @submitted="load"
    />
  </section>
</template>

<script setup>
import { computed, onMounted, onUnmounted, ref, useId, watch } from 'vue'
import PassengerAuthorizationModal from './PassengerAuthorizationModal.vue'
import { useApi } from '../../composables/useApi'
import { useSocket } from '../../composables/useSocket'
import { usePassengerAuthorizationFeature } from '../../composables/usePassengerAuthorizationFeature'
import { useAuthStore } from '../../stores/auth'
import { LIST_URL, LIVE_EVENT, listView, readFailure, readNotNow, writeNotNow } from '../../lib/passengerAuthorization'

const props = defineProps({
  compact: { type: Boolean, default: false },
  driverName: { type: String, default: '' },
  truckUnit: { type: String, default: '' },
})

const api = useApi()
const auth = useAuthStore()
const socket = useSocket()
const titleId = useId()

// The routes behind the card are a Driver's own; anyone else previewing the driver
// app never asks the feature route and never sees the card.
const isDriver = computed(() => auth.user?.role === 'Driver')
const enabled = isDriver.value ? usePassengerAuthorizationFeature(api) : ref(false)
const shown = computed(() => isDriver.value && enabled.value)

// Here only, never the store or the browser's storage: a shared phone never shows
// the previous driver's passengers.
const rows = ref([])
const loading = ref(false)
const loadError = ref('')
const showModal = ref(false)
let seq = 0

async function load() {
  if (!shown.value) return
  const mine = ++seq
  loading.value = true
  loadError.value = ''
  try {
    const answer = await api.get(LIST_URL)
    if (mine !== seq) return
    rows.value = listView(answer)
  } catch (err) {
    if (mine !== seq) return
    rows.value = []
    loadError.value = readFailure(err)
  } finally {
    if (mine === seq) loading.value = false
  }
}

watch(shown, (on) => { if (on) load() }, { immediate: true })

// "Not now" folds the onboarding card in this browser only; the server keeps no record.
function storage() {
  try { return window.localStorage } catch { return null }
}
const collapsed = ref(props.compact && readNotNow(storage()))
function setCollapsed(on) {
  collapsed.value = on
  writeNotNow(storage(), on)
}

// The company's answer reaches the driver's room (DriverView registers it); a burst
// of changes reads the list once.
let timer = null
function onChanged() {
  clearTimeout(timer)
  timer = setTimeout(load, 300)
}
onMounted(() => socket.on(LIVE_EVENT, onChanged))
onUnmounted(() => {
  socket.off(LIVE_EVENT, onChanged)
  clearTimeout(timer)
  seq++
  rows.value = []
})
</script>

<style scoped>
.pac-card { margin-top: 1rem; }
.pac-header { display: flex; align-items: center; gap: 0.65rem; margin-bottom: 0.6rem; }
.pac-icon {
  width: 32px; height: 32px; border-radius: 8px; background: var(--accent-dim); color: var(--accent);
  display: flex; align-items: center; justify-content: center; font-size: 1rem; flex-shrink: 0;
}
.pac-title { font-size: 0.95rem; font-weight: 700; margin: 0; }
.pac-optional {
  font-size: 0.68rem; font-weight: 700; padding: 0.1rem 0.5rem; border-radius: 12px;
  background: #f1f5f9; color: #475569; white-space: nowrap;
}
.pac-show {
  margin-left: auto; min-height: 44px; padding: 0 0.5rem; background: none; border: none;
  color: #0369a1; font-family: inherit; font-size: 0.85rem; font-weight: 600; cursor: pointer;
}
.pac-intro { font-size: 0.85rem; color: var(--text-dim); margin: 0 0 0.6rem; line-height: 1.45; }
.pac-empty { font-size: 0.85rem; color: var(--text-dim); margin: 0 0 0.75rem; display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem; }
.pac-list { list-style: none; margin: 0 0 0.75rem; padding: 0; display: flex; flex-direction: column; gap: 0.5rem; }
.pac-row {
  display: flex; flex-direction: column; align-items: flex-start; gap: 0.25rem;
  padding: 0.7rem 0.85rem; background: var(--bg); border: 1px solid var(--border); border-radius: 10px; min-width: 0;
}
.pac-row-top { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.25rem 0.5rem; min-width: 0; }
.pac-name { font-size: 0.9rem; font-weight: 600; color: var(--text); overflow-wrap: anywhere; }
.pac-tag {
  font-size: 0.68rem; font-weight: 700; padding: 0.1rem 0.5rem; border-radius: 12px;
  background: #fef3c7; color: #92400e; white-space: nowrap;
}
.pac-status { font-size: 0.75rem; font-weight: 700; padding: 0.15rem 0.55rem; border-radius: 12px; }
.pac-wait { background: #fef3c7; color: #92400e; }
.pac-ok { background: #dcfce7; color: #166534; }
.pac-ended { background: #f1f5f9; color: #475569; }
.pac-trip { font-size: 0.85rem; color: var(--text); overflow-wrap: anywhere; }
.pac-meta { display: flex; flex-wrap: wrap; gap: 0.25rem 0.75rem; font-size: 0.78rem; color: var(--text-dim); }
.pac-link {
  display: inline-flex; align-items: center; min-height: 44px; padding: 0; background: none; border: none;
  color: #0369a1; font-family: inherit; font-size: 0.85rem; font-weight: 600; text-decoration: none; cursor: pointer;
}
.pac-actions { display: flex; flex-wrap: wrap; gap: 0.5rem; }
.pac-btn {
  display: flex; align-items: center; justify-content: center; min-height: 44px; padding: 0.5rem 0.9rem;
  border-radius: var(--radius, 8px); font-family: inherit; font-size: 0.85rem; font-weight: 600; cursor: pointer;
}
.pac-primary { flex: 1 1 auto; border: 1px solid var(--accent); background: transparent; color: #0369a1; }
.pac-ghost { border: 1px solid transparent; background: transparent; color: var(--text-dim); }
.pac-btn:focus-visible, .pac-link:focus-visible, .pac-show:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
@media (min-width: 768px) {
  .pac-primary { flex: 0 0 auto; padding: 0.5rem 1.25rem; }
}
</style>
