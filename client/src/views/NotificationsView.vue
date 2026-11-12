<template>
  <div class="notifications-page admin-page">
    <div class="page-header">
      <h2>Notifications</h2>
      <button
        v-if="store.unreadCount > 0 && !isMobile"
        class="btn btn-secondary btn-sm"
        @click="store.markAllRead()"
      >Mark all read</button>
    </div>
    <div class="notif-container">
      <div v-if="store.notifications.length === 0" class="notif-empty">
        No notifications yet.
      </div>
      <!-- Day-bucket grouping. Triages a long backlog far faster than a flat
           list — "what came in today?" is the common question on mobile. -->
      <template v-else v-for="group in groupedNotifications" :key="group.key">
        <div v-if="group.items.length" class="notif-group-header">
          {{ group.label }}
          <span class="notif-group-count">{{ group.items.length }}</span>
        </div>
        <div
          v-for="n in group.items"
          :key="n.id"
          :class="['notif-item', { unread: !n.read }]"
          @click="handleTap(n)"
        >
          <div class="notif-icon" v-html="iconFor(n.type)"></div>
          <div class="notif-content">
            <div class="notif-title">{{ n.title }}</div>
            <div class="notif-body" v-if="n.body">{{ n.body }}</div>
            <!-- A driver's time-off request: one tap approves or declines it;
                 a button's click stays on the button. Once decided, who did. -->
            <template v-if="requestOf(n)">
              <div v-if="requestOf(n).decision" class="notif-decision">{{ requestDecisionText(requestOf(n).decision, requestOf(n).decidedBy) }}</div>
              <div v-else class="notif-actions">
                <button type="button" class="btn btn-primary btn-sm notif-act" :disabled="deciding !== 0" @click.stop="decide(n, 'approve')">Approve</button>
                <button type="button" class="btn btn-secondary btn-sm notif-act" :disabled="deciding !== 0" @click.stop="decide(n, 'decline')">Decline</button>
              </div>
              <div v-if="decideError.id === requestOf(n).availabilityId" class="notif-error" role="alert">{{ decideError.text }}</div>
              <!-- The note to CHR's contact, once approved: the server's state, and the line to copy. -->
              <div v-if="chrOf(n)" class="notif-chr">
                <span>{{ chrOf(n).words }}</span>
                <template v-if="chrOf(n).line">
                  <span class="notif-chr-line">{{ chrOf(n).line }}</span>
                  <button type="button" class="btn btn-secondary btn-sm notif-act" @click.stop="copyLine(n.id, chrOf(n).line)">{{ copiedId === n.id ? CHR_DRAFT_COPIED : CHR_DRAFT_COPY }}</button>
                </template>
              </div>
            </template>
            <div class="notif-time">{{ formatNotificationTime(n.createdAt) }}</div>
          </div>
          <span v-if="!n.read" class="notif-dot"></span>
        </div>
      </template>
    </div>
    <ConfirmModal
      :open="!!pendingLoads"
      title="This driver has loads on these days"
      :message="pendingLoads ? pendingLoads.message : ''"
      confirm-text="Approve anyway"
      cancel-text="Keep waiting"
      @confirm="approveAnyway"
      @cancel="pendingLoads = null"
    />
    <!-- Mobile: Mark-all-read as a sticky action bar. On desktop the page
         header button covers this; we hide it above 767 px. -->
    <div v-if="isMobile && store.unreadCount > 0" class="notif-mobile-footer">
      <button class="btn btn-secondary" @click="store.markAllRead()">
        Mark all {{ store.unreadCount }} as read
      </button>
    </div>
  </div>
</template>

<script setup>
import { onMounted, onUnmounted, computed, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useDispatchNotificationsStore } from '../stores/dispatchNotifications'
import { useSocket } from '../composables/useSocket'
import { useViewport } from '../composables/useViewport'
import { useApi } from '../composables/useApi'
import { appDayOf, appToday, shiftYmd } from '../utils/datetime'
import { loadIdRef } from '../lib/loadRef'
import { HIDDEN_LOAD_NOTICE_TYPE } from '../lib/deletedLoadsView.js'
import {
  CHR_DRAFT_COPIED, CHR_DRAFT_COPY, chrDraftOfNotice, chrDraftText, isDriverHasLoadsWarning, requestDecisionText, timeOffRequestOfNotice, withLoadsConfirmed,
} from '../lib/availabilityText'
import ConfirmModal from '../components/shared/ConfirmModal.vue'

const store = useDispatchNotificationsStore()
const socket = useSocket()
const router = useRouter()
const api = useApi()
const { isMobile } = useViewport()

// The request a time-off-request notice is about, or null (lib/availabilityText.js).
const requestOf = (n) => timeOffRequestOfNotice(n)
// The note to CHR's contact on that notice, as { words, line }, or null.
const chrOf = (n) => chrDraftText(chrDraftOfNotice(n))
// The notice whose line was just copied (its button says so for a moment).
const copiedId = ref(0)
let copiedTimer = null

async function copyLine(id, line) {
  try {
    await navigator.clipboard.writeText(line)
    copiedId.value = id
    if (copiedTimer) clearTimeout(copiedTimer)
    copiedTimer = setTimeout(() => { copiedId.value = 0 }, 1500)
  } catch {
    // The clipboard can be refused (permissions, no HTTPS): the line is shown to copy by hand.
    window.prompt('Copy this line for CHR\'s contact:', line)
  }
}
// The request being decided (its availability id; 0 for none), the last refusal
// in the server's words, and the server's loads question ("Approve anyway").
const deciding = ref(0)
const decideError = reactive({ id: 0, text: '' })
const pendingLoads = ref(null)

// One tap: approve or decline. Over loads the driver already has, the server
// asks first in its own words; "Approve anyway" re-sends with its list echoed
// back. A request someone else decided (or the driver withdrew) meanwhile shows
// the server's words and the notices reload.
async function decide(n, decision, body = {}) {
  const req = requestOf(n)
  if (!req || deciding.value) return
  deciding.value = req.availabilityId
  decideError.id = 0
  decideError.text = ''
  try {
    const reply = await api.post(`/api/driver-availability/${req.availabilityId}/${decision}`, body)
    store.setRequestDecision(req.availabilityId, reply.decision, reply.decidedBy)
    if (reply.chrDraft) store.setRequestChrDraft(req.availabilityId, reply.chrDraft)
    if (!n.read) store.markRead([n.id])
  } catch (err) {
    if (decision === 'approve' && isDriverHasLoadsWarning(err)) {
      pendingLoads.value = { n, message: err.message, body: withLoadsConfirmed({}, err.data) }
    } else {
      decideError.id = req.availabilityId
      decideError.text = (err && err.message) || 'The request could not be decided.'
      if (err && (err.status === 409 || err.status === 404)) store.fetch()
    }
  } finally {
    deciding.value = 0
  }
}

function approveAnyway() {
  const pending = pendingLoads.value
  pendingLoads.value = null
  if (pending) decide(pending.n, 'approve', pending.body)
}

// Another staff member's decision, or the driver's own withdrawal, while this page is open.
function onRequestDecided(payload) {
  if (!payload || typeof payload !== 'object') return
  store.setRequestDecision(payload.availabilityId, payload.decision, payload.decidedBy)
}

// A note to CHR's contact finished drafting (the event carries its state only):
// the notices are read again for its words and line.
function onChrDraft() {
  store.fetch()
}

// Day-bucket grouping. Today / Yesterday / This Week / Older — applied to
// both desktop and mobile because scanning a 200-row flat list is tedious
// everywhere. Items within a bucket preserve their existing ORDER BY id
// DESC server-side sort (newest first). The days are the app's calendar
// (APP_TIMEZONE, utils/datetime.js), not the viewer's: each notification's
// day key is compared with today's, so "Today" means the same for everyone.
const groupedNotifications = computed(() => {
  const groups = [
    { key: 'today',     label: 'Today',     items: [] },
    { key: 'yesterday', label: 'Yesterday', items: [] },
    { key: 'thisWeek',  label: 'This Week', items: [] },
    { key: 'older',     label: 'Older',     items: [] },
  ]
  const today = appToday()
  const yesterday = shiftYmd(today, -1)
  const weekAgo = shiftYmd(today, -7)
  for (const n of store.notifications) {
    const day = n.createdAt ? appDayOf(n.createdAt) : ''
    if (!day) { groups[3].items.push(n); continue }
    if (day >= today) groups[0].items.push(n)
    else if (day >= yesterday) groups[1].items.push(n)
    else if (day >= weekAgo) groups[2].items.push(n)
    else groups[3].items.push(n)
  }
  return groups
})

function iconFor(type) {
  if (type === 'status-updated') return '&#128260;'
  if (type === 'pod-uploaded') return '&#128196;'
  if (type === 'geofence') return '&#128205;'
  if (type === 'time-off-request') return '&#128197;'
  return '&#128276;'
}

// Absolute timestamp — "04/15/2026 10:30PM" — per 2026-04-21 client request.
// Exact times are more useful than "2h ago" for operational logs (POD hits,
// driver arrivals, cancellations). Input is ISO-UTC from the server; JS
// converts to the viewer's local timezone automatically.
function formatNotificationTime(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  if (isNaN(d.getTime())) return ''
  const pad = (n) => String(n).padStart(2, '0')
  const mm = pad(d.getMonth() + 1)
  const dd = pad(d.getDate())
  const yyyy = d.getFullYear()
  let h = d.getHours()
  const m = pad(d.getMinutes())
  const ampm = h >= 12 ? 'PM' : 'AM'
  h = h % 12 || 12
  return `${mm}/${dd}/${yyyy} ${h}:${m}${ampm}`
}

function handleTap(n) {
  if (!n.read) {
    store.markRead([n.id])
  }
  // A load an old delete hides is on no list: its banner on the dashboard is where it is reviewed.
  if (n.type === HIDDEN_LOAD_NOTICE_TYPE) {
    router.push({ path: '/dashboard' })
    return
  }
  // Route to /dashboard?load=<id> when the notification carries one.
  // Every server emitter today puts loadId in metadata — see server.js
  // dispatch notification insertions. DashboardView opens the matching
  // load's detail modal automatically.
  // A load whose Load ID this user is served withheld comes with its key
  // (metadata.loadKey, the Dispatcher Load ID plan): the dashboard opens it by that.
  let loadId = ''
  try {
    const meta = typeof n.metadata === 'string' ? JSON.parse(n.metadata || '{}') : (n.metadata || {})
    loadId = loadIdRef(meta)
  } catch { /* ignore unparseable metadata */ }
  if (loadId) {
    router.push({ path: '/dashboard', query: { load: loadId } })
  }
}

function onSocketNotification(payload) {
  store.addRealtime({
    id: Date.now(),
    type: payload.type || 'info',
    title: payload.title || '',
    body: payload.body || '',
    metadata: JSON.stringify(payload),
    read: 0,
    createdAt: new Date().toISOString(),
  })
}

onMounted(() => {
  store.fetch()
  socket.connect()
  socket.register('dispatch')
  socket.on('dispatch-notification', onSocketNotification)
  socket.on('time-off-request-decided', onRequestDecided)
  socket.on('time-off-chr-draft', onChrDraft)
})

onUnmounted(() => {
  socket.off('dispatch-notification', onSocketNotification)
  socket.off('time-off-request-decided', onRequestDecided)
  socket.off('time-off-chr-draft', onChrDraft)
  if (copiedTimer) clearTimeout(copiedTimer)
})
</script>

<style scoped>
.notif-container {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow: hidden;
}
.notif-empty {
  text-align: center;
  color: var(--text-dim);
  font-size: 0.88rem;
  padding: 3rem 1rem;
}
.notif-item {
  display: flex;
  align-items: flex-start;
  gap: 0.75rem;
  padding: 0.85rem 1rem;
  border-bottom: 1px solid var(--border);
  cursor: pointer;
  transition: background 0.12s;
}
.notif-item:last-child { border-bottom: none; }
.notif-item:hover { background: var(--surface-hover); }
.notif-item.unread { background: rgba(99, 102, 241, 0.04); }
.notif-icon {
  font-size: 1.1rem;
  flex-shrink: 0;
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg);
  border-radius: 8px;
}
.notif-content {
  flex: 1;
  min-width: 0;
}
.notif-title {
  font-size: 0.85rem;
  font-weight: 600;
  color: var(--text);
}
.notif-body {
  font-size: 0.78rem;
  color: var(--text-dim);
  margin-top: 0.1rem;
}
.notif-time {
  font-size: 0.68rem;
  color: var(--text-dim);
  margin-top: 0.25rem;
  font-family: 'JetBrains Mono', monospace;
}
.notif-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin-top: 0.5rem;
}
.notif-decision {
  font-size: 0.78rem;
  font-weight: 600;
  color: var(--text);
  margin-top: 0.35rem;
}
.notif-error {
  font-size: 0.75rem;
  color: #b91c1c;
  margin-top: 0.35rem;
  overflow-wrap: anywhere;
}
.notif-chr {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.35rem 0.5rem;
  font-size: 0.78rem;
  color: var(--text);
  margin-top: 0.35rem;
  overflow-wrap: anywhere;
}
.notif-chr-line {
  font-weight: 600;
}
.notif-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--accent);
  flex-shrink: 0;
  margin-top: 0.35rem;
}

/* Day-bucket header — visible on desktop and mobile. */
.notif-group-header {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.65rem 1rem 0.45rem;
  font-size: 0.68rem;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--text-dim);
  background: var(--bg);
  border-bottom: 1px solid var(--border);
}
.notif-group-count {
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  font-weight: 700;
  font-size: 0.65rem;
  background: var(--border);
  color: var(--text-dim);
  padding: 0.1rem 0.45rem;
  border-radius: 10px;
}

/* Mobile — larger tap targets, sticky mark-all-read footer. */
@media (max-width: 767px) {
  .notif-item {
    min-height: 56px;
    padding: 0.9rem 0.85rem;
    gap: 0.65rem;
  }
  .notif-icon {
    width: 36px;
    height: 36px;
    font-size: 1.15rem;
  }
  .notif-title { font-size: 0.9rem; }
  .notif-body { font-size: 0.8rem; }
  .notif-act { min-height: 44px; min-width: 44px; flex: 1 1 8rem; }
  .notif-time { font-size: 0.72rem; margin-top: 0.3rem; }
  .notif-mobile-footer {
    position: sticky;
    bottom: 0;
    left: 0;
    right: 0;
    padding: 0.75rem;
    background: rgba(255, 255, 255, 0.96);
    backdrop-filter: blur(6px);
    border-top: 1px solid var(--border);
    margin-top: 0.75rem;
    z-index: 10;
  }
  .notif-mobile-footer .btn {
    display: block;
    width: 100%;
    padding: 0.85rem;
    font-size: 0.9rem;
    font-weight: 600;
  }
}
</style>
