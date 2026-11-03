<template>
  <div class="pa-page admin-page" style="overflow-y:auto;min-height:auto;flex:none;">
    <div class="page-header pa-header">
      <div class="pa-heading">
        <h2>Passenger authorizations</h2>
        <p class="pa-desc">A passenger may ride only after LogisX Inc. signs the driver's authorization here. Open the PDF and read it before you sign.</p>
        <p v-if="reviewNote" class="pa-desc">{{ reviewNote }}</p>
      </div>
    </div>

    <p v-if="featureOff" class="pa-off" role="status">Passenger authorizations are switched off on this server.</p>
    <template v-else>
      <Tabs :model-value="tab" @update:model-value="selectTab">
        <TabsList class="pa-tabs">
          <TabsTrigger v-for="t in TABS" :key="t.key" :value="t.key">{{ t.label }}</TabsTrigger>
        </TabsList>
      </Tabs>

      <SkeletonLoader v-if="loading && !loaded" :rows="3" :cols="6" />
      <div v-else-if="!loaded && error" class="load-error" role="alert">
        <span>{{ error }}</span>
        <button type="button" class="btn btn-secondary btn-sm" @click="load">Retry</button>
      </div>
      <template v-else>
        <p v-if="error" class="load-error" role="alert">
          <span>{{ error }} This is the list as last loaded.</span>
          <button type="button" class="btn btn-secondary btn-sm" @click="load">Retry</button>
        </p>

        <EmptyState v-if="!rows.length">{{ emptyText }}</EmptyState>

        <!-- Phone: one card per authorization, every field labelled. -->
        <ul v-else-if="isMobile" class="pa-cards" aria-label="Passenger authorizations">
          <li v-for="r in rows" :key="r.id" class="pa-card">
            <div class="pa-card-ref">{{ r.reference }}</div>
            <dl class="pa-fields">
              <div class="pa-field"><dt>Driver</dt><dd>{{ r.driverName }}</dd></div>
              <div class="pa-field"><dt>Passenger</dt><dd>{{ r.passengerName }}<span class="pa-sub">{{ passengerText(r) }}</span></dd></div>
              <div class="pa-field"><dt>Trip</dt><dd>{{ tripText(r) }}</dd></div>
              <div class="pa-field"><dt>Dates</dt><dd>{{ datesText(r) }}</dd></div>
              <div class="pa-field"><dt>Status</dt><dd>{{ statusText(r) }}<span class="pa-sub">{{ decisionText(r) }}</span></dd></div>
            </dl>
            <div class="pa-actions">
              <a :href="pdfUrl(r.id)" target="_blank" rel="noopener noreferrer" class="pa-link">Open PDF</a>
              <Button v-if="actionsFor(r).countersign" size="sm" @click="openSign(r)">Sign for LogisX</Button>
              <Button v-if="actionsFor(r).decline" size="sm" variant="outline" @click="openReason(r, 'decline')">Decline</Button>
              <Button v-if="actionsFor(r).revoke" size="sm" variant="outline" @click="openReason(r, 'revoke')">Revoke</Button>
            </div>
          </li>
        </ul>

        <Table v-else>
          <TableHeader>
            <TableRow>
              <TableHead>Reference</TableHead>
              <TableHead>Driver</TableHead>
              <TableHead>Passenger</TableHead>
              <TableHead>Trip</TableHead>
              <TableHead>Dates</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow v-for="r in rows" :key="r.id" class="pa-row">
              <TableCell class="pa-ref">{{ r.reference }}</TableCell>
              <TableCell>{{ r.driverName }}</TableCell>
              <TableCell>{{ r.passengerName }}<span class="pa-sub">{{ passengerText(r) }}</span></TableCell>
              <TableCell>{{ tripText(r) }}</TableCell>
              <TableCell class="pa-nowrap">{{ datesText(r) }}</TableCell>
              <TableCell>{{ statusText(r) }}<span class="pa-sub">{{ decisionText(r) }}</span></TableCell>
              <TableCell>
                <div class="pa-actions">
                  <a :href="pdfUrl(r.id)" target="_blank" rel="noopener noreferrer" class="pa-link">Open PDF</a>
                  <Button v-if="actionsFor(r).countersign" size="sm" @click="openSign(r)">Sign for LogisX</Button>
                  <Button v-if="actionsFor(r).decline" size="sm" variant="outline" @click="openReason(r, 'decline')">Decline</Button>
                  <Button v-if="actionsFor(r).revoke" size="sm" variant="outline" @click="openReason(r, 'revoke')">Revoke</Button>
                </div>
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </template>
    </template>

    <Dialog :open="sign.open" @update:open="(v) => { if (!v) closeSign() }">
      <DialogScrollContent class="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>Sign for LogisX Inc.</DialogTitle>
          <DialogDescription>Authorization {{ sign.row?.reference }}. It is valid only once you sign it.</DialogDescription>
        </DialogHeader>
        <template v-if="sign.row">
          <dl class="pa-fields">
            <div class="pa-field"><dt>Driver</dt><dd>{{ sign.row.driverName }}</dd></div>
            <div class="pa-field"><dt>Passenger</dt><dd>{{ sign.row.passengerName }}<span class="pa-sub">{{ passengerText(sign.row) }}</span></dd></div>
            <div class="pa-field"><dt>Trip</dt><dd>{{ tripText(sign.row) }}</dd></div>
            <div class="pa-field"><dt>Dates</dt><dd>{{ datesText(sign.row) }}</dd></div>
          </dl>
          <a :href="pdfUrl(sign.row.id)" target="_blank" rel="noopener noreferrer" class="pa-link">Open the PDF to read it</a>
          <label class="pa-label">Your full name
            <input v-model="sign.printedName" class="pa-input" :maxlength="PRINTED_NAME_MAX" autocomplete="name" />
          </label>
          <label class="pa-label">Your title
            <input v-model="sign.title" class="pa-input" :maxlength="TITLE_MAX" autocomplete="organization-title" />
          </label>
          <p class="pa-note">The admin login is shared, so it records the account only: type your own name and title.</p>
          <label class="pa-consent">
            <input v-model="sign.agreed" type="checkbox" />
            <span>{{ SIGNING_CONSENT_TEXT }}</span>
          </label>
          <SignaturePad
            :key="sign.padKey"
            ref="padRef"
            :disabled="!sign.agreed"
            label="Signature for LogisX Inc."
            hint="Tick the box above, then sign with your finger or mouse."
          />
          <p v-if="sign.error" class="pa-error" role="alert">{{ sign.error }}</p>
        </template>
        <DialogFooter>
          <Button variant="outline" @click="closeSign">Cancel</Button>
          <Button :disabled="sign.busy" @click="submitSign">{{ sign.busy ? 'Signing…' : 'Sign for LogisX Inc.' }}</Button>
        </DialogFooter>
      </DialogScrollContent>
    </Dialog>

    <Dialog :open="decide.open" @update:open="(v) => { if (!v) closeReason() }">
      <DialogContent class="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>{{ decide.kind === 'revoke' ? 'Revoke this authorization' : 'Decline this authorization' }}</DialogTitle>
          <DialogDescription>
            {{ decide.kind === 'revoke'
              ? 'It ends now: the passenger may no longer ride. The driver is told in the app.'
              : 'It will not be signed. The driver is told in the app and can file a new one.' }}
          </DialogDescription>
        </DialogHeader>
        <label class="pa-label">Reason
          <textarea v-model="decide.reason" class="pa-input" rows="3" :maxlength="REASON_MAX"></textarea>
        </label>
        <p v-if="decide.error" class="pa-error" role="alert">{{ decide.error }}</p>
        <DialogFooter>
          <Button variant="outline" @click="closeReason">Cancel</Button>
          <Button variant="destructive" :disabled="decide.busy" @click="submitReason">
            {{ decide.busy ? 'Saving…' : (decide.kind === 'revoke' ? 'Revoke' : 'Decline') }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'
import { useApi } from '../composables/useApi'
import { useSocketRefresh } from '../composables/useSocketRefresh'
import { useViewport } from '../composables/useViewport'
import { useToast } from '../composables/useToast'
import { SIGNING_CONSENT_TEXT } from '../lib/signingConsent.js'
import {
  LIVE_EVENT, TABS, PRINTED_NAME_MAX, TITLE_MAX, REASON_MAX, tabKey, listUrl, rowsForTab, actionsFor,
  statusText, passengerText, tripText, datesText, decisionText, pdfUrl, countersignUrl, declineUrl, revokeUrl,
  countersignProblem, countersignPayload, reasonProblem, reasonPayload, reloadAfter, actionErrorText, listErrorText,
} from '../lib/passengerAuthorizationAdmin.js'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Dialog, DialogContent, DialogScrollContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import SkeletonLoader from '../components/shared/SkeletonLoader.vue'
import EmptyState from '../components/shared/EmptyState.vue'
import SignaturePad from '../components/shared/SignaturePad.vue'

// Super Admin only (router meta here; requireRole on every route it calls). Passengers'
// names, minors' included, stay in this page's memory: nothing is logged or stored.
const api = useApi()
const { isMobile } = useViewport()
const { show: toast } = useToast()

const tab = ref('waiting')
const listed = ref([])
const rows = computed(() => rowsForTab(listed.value, tab.value))
const loading = ref(false)
const loaded = ref(false)
const error = ref('')
const featureOff = ref(false)
const reviewNote = ref('')
const emptyText = computed(() => ({
  waiting: 'Nothing is waiting for a company signature.',
  authorized: 'No authorization is in force or starting later.',
  ended: 'No ended authorizations.',
}[tab.value]))

// A slower answer for a tab left behind never overwrites the tab on screen.
let seq = 0
async function load() {
  const mine = ++seq
  loading.value = true
  try {
    const res = await api.get(listUrl(tab.value))
    if (mine !== seq) return
    listed.value = Array.isArray(res.authorizations) ? res.authorizations : []
    if (typeof res.reviewNote === 'string') reviewNote.value = res.reviewNote
    loaded.value = true
    error.value = ''
  } catch (err) {
    if (mine !== seq) return
    if (err && err.code === 'FEATURE_OFF') {
      featureOff.value = true
      listed.value = []
    }
    error.value = listErrorText(err)
  } finally {
    if (mine === seq) loading.value = false
  }
}

function selectTab(key) {
  tab.value = tabKey(key)
  listed.value = []
  loaded.value = false
  error.value = ''
  load()
}

// One state object per open dialog, replaced whole on open and on close, so no name,
// title or tick carries over to the next authorization. The signature stays in the pad,
// which is remounted on every open, and is read from it only when the button is pressed.
const blankSign = () => ({ open: false, row: null, printedName: '', title: '', agreed: false, padKey: 0, busy: false, error: '' })
const sign = ref(blankSign())
const padRef = ref(null)
let padKey = 0

function openSign(row) {
  sign.value = { ...blankSign(), open: true, row, padKey: ++padKey }
}

function closeSign() {
  sign.value = blankSign()
}

// The click pins its own state object: a dialog closed or reopened while the request is
// out never takes this answer.
async function submitSign() {
  const s = sign.value
  if (s.busy || !s.row) return
  const form = { printedName: s.printedName, title: s.title, agreed: s.agreed, signatureImage: (padRef.value && padRef.value.toDataURL()) || '' }
  const problem = countersignProblem(form)
  if (problem) {
    s.error = problem
    return
  }
  s.busy = true
  s.error = ''
  try {
    await api.post(countersignUrl(s.row.id), countersignPayload(form), { timeout: 60000 })
    if (sign.value === s) closeSign()
    toast(`Signed for LogisX Inc. (${s.row.reference}). The driver is told in the app.`)
    load()
  } catch (err) {
    if (sign.value === s) {
      s.error = actionErrorText(err)
      s.busy = false
    }
    if (reloadAfter(err)) load()
  }
}

const blankDecide = () => ({ open: false, kind: 'decline', row: null, reason: '', busy: false, error: '' })
const decide = ref(blankDecide())

function openReason(row, kind) {
  decide.value = { ...blankDecide(), open: true, kind: kind === 'revoke' ? 'revoke' : 'decline', row }
}

function closeReason() {
  decide.value = blankDecide()
}

async function submitReason() {
  const d = decide.value
  if (d.busy || !d.row) return
  const problem = reasonProblem(d.reason)
  if (problem) {
    d.error = problem
    return
  }
  d.busy = true
  d.error = ''
  const url = d.kind === 'revoke' ? revokeUrl(d.row.id) : declineUrl(d.row.id)
  try {
    await api.post(url, reasonPayload(d.reason))
    if (decide.value === d) closeReason()
    toast(`${d.kind === 'revoke' ? 'Revoked' : 'Declined'} ${d.row.reference}. The driver is told in the app.`)
    load()
  } catch (err) {
    if (decide.value === d) {
      d.error = actionErrorText(err)
      d.busy = false
    }
    if (reloadAfter(err)) load()
  }
}

useSocketRefresh(LIVE_EVENT, () => load())
load()
</script>

<style scoped>
.pa-header { align-items: flex-start; }
.pa-heading { min-width: 0; }
.pa-desc { margin: 0.25rem 0 0; font-size: 0.82rem; color: var(--text-dim); }
.pa-off { font-size: 0.85rem; color: var(--text-dim); }
.pa-tabs { margin-bottom: 0.75rem; }
.pa-ref { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.8rem; }
.pa-nowrap { white-space: nowrap; }
.pa-row > td { vertical-align: top; }
.pa-sub { display: block; font-size: 0.72rem; color: var(--text-dim); }
.pa-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem; }
.pa-link { font-size: 0.82rem; font-weight: 600; color: var(--accent); text-decoration: none; }
.pa-link:hover, .pa-link:focus-visible { text-decoration: underline; }
.pa-cards { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.75rem; }
.pa-card { border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); padding: 0.85rem 1rem; min-width: 0; }
.pa-card-ref { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-weight: 700; font-size: 0.9rem; margin-bottom: 0.5rem; }
.pa-fields { margin: 0 0 0.6rem; display: flex; flex-direction: column; gap: 0.35rem; }
.pa-field { display: grid; grid-template-columns: 5.5rem minmax(0, 1fr); gap: 0.5rem; font-size: 0.82rem; }
.pa-field dt { color: var(--text-dim); font-weight: 600; }
.pa-field dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
.pa-label { display: flex; flex-direction: column; gap: 0.3rem; font-size: 0.82rem; font-weight: 600; }
.pa-input { border: 1px solid var(--border); border-radius: 6px; padding: 0.45rem 0.6rem; font-size: 0.9rem; font-weight: 400; }
.pa-note { margin: 0; font-size: 0.75rem; color: var(--text-dim); }
.pa-consent { display: flex; align-items: flex-start; gap: 0.5rem; font-size: 0.82rem; }
.pa-error { margin: 0; font-size: 0.8rem; font-weight: 600; color: #b91c1c; }
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
