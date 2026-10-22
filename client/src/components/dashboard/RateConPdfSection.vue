<!--
  The load's rate con, in a tile under the load-detail map (dispatch Active and
  Completed). Super Admin only.

  The server is the gate: GET /api/loads/:loadId/ratecon.pdf answers 401/403 to
  everyone else (lib/ratecon-pdf-route.js). This component also renders
  nothing, and asks for nothing, unless the signed-in user is a Super Admin, so
  no other role sees an empty tile or spends a request on a 403.

  The bytes are fetched with the session cookie and X-Requested-With (as
  useApi does; useApi itself only reads JSON), kept as a blob: URL and drawn
  in-page by RateConViewer (pdf.js), never in an iframe.
-->
<template>
  <div v-if="isSuperAdmin" class="rc-section">
    <div class="dash-section-title">Rate Con</div>
    <div v-if="state === 'loading'" class="rc-state" role="status">Loading the rate con…</div>
    <div v-else-if="state === 'error'" class="rc-state">{{ message }}</div>
    <RateConViewer v-else-if="state === 'ready'" class="rc-viewer" :src="src" />
  </div>
</template>

<script setup>
import { ref, computed, watch, onBeforeUnmount } from 'vue'
import { useAuthStore } from '../../stores/auth'
import { rateConPdfUrl, rateConFailureText, RATECON_UNAVAILABLE } from '../../lib/rateConView'
import RateConViewer from '../shared/RateConViewer.vue'

const props = defineProps({
  loadId: { type: String, default: '' },
  // The modal owns visibility: nothing is fetched for a closed modal.
  open: { type: Boolean, default: false },
})

const FETCH_TIMEOUT_MS = 30000

const auth = useAuthStore()
const isSuperAdmin = computed(() => auth.isSuperAdmin === true)

const state = ref('idle') // idle | loading | ready | error
const message = ref('')
const src = ref('')
let controller = null

function release() {
  if (controller) { controller.abort(); controller = null }
  if (src.value) { URL.revokeObjectURL(src.value); src.value = '' }
}

async function fetchRateCon(id) {
  release()
  const ctrl = new AbortController()
  controller = ctrl
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
  state.value = 'loading'
  message.value = ''
  try {
    const res = await fetch(rateConPdfUrl(id), {
      credentials: 'same-origin',
      headers: { 'X-Requested-With': 'XMLHttpRequest' },
      signal: ctrl.signal,
    })
    if (!res.ok) {
      let serverMessage = ''
      let serverCode = ''
      try {
        const body = await res.json()
        serverMessage = body.error || ''
        serverCode = body.code || ''
      } catch { serverMessage = '' }
      if (controller !== ctrl) return
      state.value = 'error'
      message.value = rateConFailureText(res.status, serverMessage, serverCode)
      return
    }
    const blob = await res.blob()
    if (controller !== ctrl) return
    src.value = URL.createObjectURL(blob)
    state.value = 'ready'
  } catch {
    if (controller !== ctrl) return
    state.value = 'error'
    message.value = RATECON_UNAVAILABLE
  } finally {
    clearTimeout(timer)
    if (controller === ctrl) controller = null
  }
}

watch(() => [props.loadId, props.open, isSuperAdmin.value], ([id, open, allowed]) => {
  const loadId = String(id || '').trim()
  if (open && loadId && allowed) fetchRateCon(loadId)
  else { release(); state.value = 'idle' }
}, { immediate: true })

onBeforeUnmount(release)
</script>

<style scoped>
.rc-section { margin-top: 1rem; }
/* On a phone the viewer takes 1rem of the load dialog's 1.25rem body padding
   on each side (390 px wide: about 302 -> 334 px); the dialog and the section
   title stay as they are. The CSS full-screen fallback (fixed, inset 0) takes
   no margin; native full screen resets margins itself. */
@media (max-width: 480px) {
  .rc-section .rc-viewer { margin-left: -1rem; margin-right: -1rem; max-width: none; }
  .rc-section .rc-viewer.rcv-expanded { margin: 0; }
}
.rc-state {
  font-size: 0.82rem; color: #6b7280; padding: 0.9rem 0.75rem;
  border: 1px dashed #e5e7eb; border-radius: 8px; text-align: center;
}
</style>
