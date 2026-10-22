<!--
  Rate-con driver instructions, the staff side (plan PR 3, §4): in the load
  detail of the Job Board and Active Loads, for a Super Admin or a Dispatcher.

  It shows exactly what the driver will see (the server's `driverPreview`), the
  status, the review reasons in the server's words, and a pending re-issue side
  by side with what drivers see now. Buttons: Edit (every item: add, change,
  remove references, requirements and instructions, and stops), Mark reviewed,
  Accept the new rate con / Keep current, Re-read the rate con.

  The server is the gate (GET / PUT /api/loads/:loadId/driver-instructions and
  POST .../review, .../accept-pending, .../re-extract): it decides what a driver
  may see and refuses an edit it can't show. This section displays what it is
  sent and sends what was typed; it never filters or rewrites content. While the
  server's flag is off every route answers 404 and the section renders nothing.
  A refusal is told by its code and the kind of field only, never which item
  (lib/driverInstructionsView.js; scripts/test-driver-instructions-client.mjs).

  Edit locks (decision 37): a person whose save was refused for a carrier account
  number is locked out of instruction edits. Their section shows the locked
  message instead of the edit controls (the server's `editLocked`, or a 423 on a
  write). A Super Admin also sees the list of locked people, with when each was
  locked, and clears one at a time; never their own (the server refuses it).
-->
<template>
  <section v-if="visible" class="di-section" aria-labelledby="di-title" data-testid="driver-instructions">
    <div class="dash-section-title" style="display:flex;align-items:center;gap:0.5rem;flex-wrap:wrap;">
      <span id="di-title">Driver instructions</span>
      <span v-if="body" class="di-chip" :class="`di-chip-${status.tone}`" data-testid="di-status">{{ status.label }}</span>
    </div>
    <div class="rounded-lg border border-gray-200 bg-white p-3 text-sm">
      <p v-if="loading && !body" role="status" class="text-xs text-gray-500">Loading the driver instructions…</p>

      <p v-if="errorText && !editing" role="alert" class="di-msg di-msg-error" data-testid="di-error">{{ errorText }}</p>
      <Button v-if="!body && errorText && !loading" type="button" size="sm" variant="outline" @click="load">Try again</Button>
      <p v-if="noticeText" role="status" class="di-msg di-msg-ok" data-testid="di-notice">{{ noticeText }}</p>

      <template v-if="body">
        <p v-if="locked" role="alert" class="di-msg di-msg-error" data-testid="di-locked">{{ EDIT_LOCKED_MESSAGE }}</p>
        <p class="text-xs text-gray-600">
          {{ status.note }}
          <span v-if="reviewedLine" data-testid="di-reviewed">{{ reviewedLine }}</span>
        </p>
        <p v-if="body.unmatchedFiles > 0" class="mt-1 text-xs text-gray-600">
          {{ body.unmatchedFiles === 1 ? 'A rate-con file names this load' : `${body.unmatchedFiles} rate-con files name this load` }} but couldn't be matched to it.
        </p>

        <div v-if="reasons.length" class="mt-2 rounded-md border border-amber-200 bg-amber-50 p-2" data-testid="di-reasons">
          <p class="text-xs font-semibold text-amber-900">Needs a look</p>
          <ul class="mt-1 list-disc space-y-0.5 pl-4 text-xs text-amber-900">
            <li v-for="(r, i) in reasons" :key="`${r.code}-${i}`">{{ r.text }}</li>
          </ul>
        </div>

        <div v-if="!editing && !locked" class="mt-3 flex flex-wrap gap-2">
          <Button type="button" size="sm" variant="outline" :disabled="busy" @click="startEdit">Edit</Button>
          <Button v-if="canReview" type="button" size="sm" :disabled="busy" @click="markReviewed">Mark reviewed</Button>
          <Button type="button" size="sm" variant="outline" :disabled="busy" @click="reread">Re-read the rate con</Button>
        </div>

        <div v-if="compare && !editing" class="mt-3" data-testid="di-pending">
          <p class="text-xs font-semibold text-gray-800">Drivers keep seeing the current version until you accept the new reading.</p>
          <div class="mt-2 grid grid-cols-1 gap-3 md:grid-cols-2">
            <div class="min-w-0">
              <h4 class="di-h">Drivers see now</h4>
              <DriverInstructionsPayload :payload="compare.current" />
            </div>
            <div class="min-w-0">
              <h4 class="di-h">New reading</h4>
              <ul v-if="compare.reasons.length" class="mb-2 list-disc space-y-0.5 pl-4 text-xs text-amber-900">
                <li v-for="(r, i) in compare.reasons" :key="`p-${r.code}-${i}`">{{ r.text }}</li>
              </ul>
              <DriverInstructionsPayload :payload="compare.next" show-flags />
            </div>
          </div>
          <div v-if="!locked" class="mt-2 flex flex-wrap gap-2">
            <Button type="button" size="sm" :disabled="busy" @click="decide('accept')">Accept the new rate con</Button>
            <Button type="button" size="sm" variant="outline" :disabled="busy" @click="decide('keep')">Keep current</Button>
          </div>
        </div>

        <div v-else-if="!editing" class="mt-3" data-testid="di-preview">
          <h4 class="di-h">{{ body.published ? 'What the driver sees' : 'What the driver will see once reviewed' }}</h4>
          <DriverInstructionsPayload :payload="body.driverPreview" />
        </div>

        <div v-if="hidden.length && !editing" class="mt-3" data-testid="di-hidden">
          <h4 class="di-h">Not shown to drivers</h4>
          <ul class="space-y-1 text-xs">
            <li v-for="(h, i) in hidden" :key="`h-${i}`" class="break-words rounded border border-amber-200 bg-amber-50 p-1.5">
              <span class="font-semibold">{{ h.where }} · {{ h.label }}:</span> {{ h.text }}
              <span class="block text-amber-900">{{ h.why }}</span>
            </li>
          </ul>
        </div>

        <form v-if="editing && draft" class="mt-3 space-y-3" data-testid="di-edit" @submit.prevent="save">
          <p class="text-xs text-gray-600">Saving replaces what drivers see with this version. The server checks every item: an account number, amount or contact can't be saved.</p>

          <fieldset class="di-box">
            <legend class="di-h px-1">Whole load</legend>
            <div v-for="(r, i) in draft.loadRequirements" :key="`elr-${i}`" class="di-row">
              <select v-model="r.category" class="di-select" :aria-label="`Whole-load requirement ${i + 1} kind`">
                <option v-for="(label, key) in CATEGORY_LABELS" :key="key" :value="key">{{ label }}</option>
              </select>
              <textarea v-model="r.text" rows="2" class="di-text" :aria-label="`Whole-load requirement ${i + 1} text`" />
              <Button type="button" size="sm" variant="ghost" :aria-label="`Remove whole-load requirement ${i + 1}`" @click="draft.loadRequirements.splice(i, 1)">Remove</Button>
              <p v-if="draftItemNote(r)" class="di-note">{{ draftItemNote(r) }}</p>
            </div>
            <Button type="button" size="sm" variant="outline" @click="draft.loadRequirements.push(blankRequirement())">Add requirement</Button>
          </fieldset>

          <fieldset v-for="(s, si) in draft.stops" :key="`es-${si}`" class="di-box">
            <legend class="di-h px-1">Stop {{ si + 1 }}</legend>
            <div class="grid grid-cols-1 gap-2 sm:grid-cols-3">
              <label class="di-label">Kind
                <select v-model="s.kind" class="di-select w-full">
                  <option v-for="(label, key) in STOP_KIND_LABELS" :key="key" :value="key">{{ label }}</option>
                </select>
              </label>
              <label class="di-label">Facility
                <Input v-model="s.facility" class="h-9" />
              </label>
              <label class="di-label">Place (City, ST)
                <Input v-model="s.place" class="h-9" placeholder="City, ST" />
              </label>
            </div>

            <p class="di-sub">References</p>
            <div v-for="(ref, ri) in s.references" :key="`er-${si}-${ri}`" class="di-row">
              <select :value="ref.type" class="di-select" @change="setReferenceType(ref, $event.target.value)" :aria-label="`Stop ${si + 1} reference ${ri + 1} kind`">
                <option v-for="(label, key) in REFERENCE_LABELS" :key="key" :value="key">{{ label }}</option>
              </select>
              <Input v-model="ref.label" class="h-9 sm:w-36" placeholder="Label (optional)" :aria-label="`Stop ${si + 1} reference ${ri + 1} label`" />
              <Input v-model="ref.value" class="h-9 font-mono sm:w-auto sm:min-w-[8rem] sm:flex-1" placeholder="Number" :aria-label="`Stop ${si + 1} reference ${ri + 1} number`" />
              <Button type="button" size="sm" variant="ghost" :aria-label="`Remove stop ${si + 1} reference ${ri + 1}`" @click="s.references.splice(ri, 1)">Remove</Button>
            </div>
            <Button type="button" size="sm" variant="outline" @click="s.references.push(blankReference())">Add reference</Button>

            <p class="di-sub">Requirements</p>
            <div v-for="(r, ri) in s.requirements" :key="`eq-${si}-${ri}`" class="di-row">
              <select v-model="r.category" class="di-select" :aria-label="`Stop ${si + 1} requirement ${ri + 1} kind`">
                <option v-for="(label, key) in CATEGORY_LABELS" :key="key" :value="key">{{ label }}</option>
              </select>
              <textarea v-model="r.text" rows="2" class="di-text" :aria-label="`Stop ${si + 1} requirement ${ri + 1} text`" />
              <Button type="button" size="sm" variant="ghost" :aria-label="`Remove stop ${si + 1} requirement ${ri + 1}`" @click="s.requirements.splice(ri, 1)">Remove</Button>
              <p v-if="draftItemNote(r)" class="di-note">{{ draftItemNote(r) }}</p>
            </div>
            <Button type="button" size="sm" variant="outline" @click="s.requirements.push(blankRequirement())">Add requirement</Button>

            <p class="di-sub">Instructions</p>
            <div v-for="(x, xi) in s.instructions" :key="`ei-${si}-${xi}`" class="di-row">
              <select v-model="x.kind" class="di-select" :aria-label="`Stop ${si + 1} instruction ${xi + 1} kind`">
                <option v-for="(label, key) in INSTRUCTION_KIND_LABELS" :key="key" :value="key">{{ label }}</option>
              </select>
              <textarea v-model="x.text" rows="2" class="di-text" :aria-label="`Stop ${si + 1} instruction ${xi + 1} text`" />
              <Button type="button" size="sm" variant="ghost" :aria-label="`Remove stop ${si + 1} instruction ${xi + 1}`" @click="s.instructions.splice(xi, 1)">Remove</Button>
              <p v-if="draftItemNote(x)" class="di-note">{{ draftItemNote(x) }}</p>
            </div>
            <div class="flex flex-wrap gap-2">
              <Button type="button" size="sm" variant="outline" @click="s.instructions.push(blankInstruction())">Add instruction</Button>
              <Button type="button" size="sm" variant="ghost" class="text-red-700" @click="draft.stops.splice(si, 1)">Remove stop {{ si + 1 }}</Button>
            </div>
          </fieldset>

          <div class="flex flex-wrap gap-2">
            <Button type="button" size="sm" variant="outline" @click="draft.stops.push(blankStop('pickup'))">Add pickup stop</Button>
            <Button type="button" size="sm" variant="outline" @click="draft.stops.push(blankStop('delivery'))">Add delivery stop</Button>
          </div>
          <!-- While editing, a refusal shows here, beside Save, where the person is. -->
          <p v-if="errorText" role="alert" class="di-msg di-msg-error" data-testid="di-error">{{ errorText }}</p>
          <div class="flex flex-wrap gap-2 border-t border-gray-100 pt-3">
            <Button type="submit" size="sm" :disabled="busy">Save</Button>
            <Button type="button" size="sm" variant="outline" :disabled="busy" @click="cancelEdit">Cancel</Button>
          </div>
        </form>
      </template>

      <div v-if="lockList.length" class="mt-3 rounded-md border border-red-200 bg-red-50 p-2" data-testid="di-locks">
        <p class="text-xs font-semibold text-red-900">Instruction edits locked</p>
        <p class="mt-0.5 text-xs text-red-900">A save by each person below was refused for a carrier account number, so their driver-instruction edits are locked. Clear a lock once you've checked with them.</p>
        <ul class="mt-2 space-y-1.5 text-xs">
          <li v-for="l in lockList" :key="l.userId" class="flex flex-wrap items-center gap-x-2 gap-y-1" data-testid="di-lock-row">
            <span class="font-semibold text-gray-900">{{ l.name }}</span>
            <span class="text-gray-700">{{ l.role }}<template v-if="l.lockedAt"> · locked {{ fmtAppInstant(l.lockedAt, { fallback: '' }) }}</template></span>
            <Button v-if="!l.self" type="button" size="sm" variant="outline" :disabled="busy" @click="clearLock(l.userId)">Clear lock</Button>
            <span v-else class="text-red-900">Another Super Admin must clear your lock.</span>
          </li>
        </ul>
      </div>
    </div>
  </section>
</template>

<script setup>
import { ref, computed, watch } from 'vue'
import { useApi } from '../../composables/useApi'
import { useAuthStore } from '../../stores/auth'
import { fmtAppInstant } from '../../utils/datetime'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import DriverInstructionsPayload from './DriverInstructionsPayload.vue'
import {
  canSeeDriverInstructions, instructionsUrl, instructionsError, statusView, canMarkReviewed,
  rereadResultText, pendingCompare, hiddenFromDrivers, draftItemNote, doneText, setReferenceType,
  editDraftFrom, editBody, blankReference, blankRequirement, blankInstruction, blankStop,
  REFERENCE_LABELS, CATEGORY_LABELS, INSTRUCTION_KIND_LABELS, STOP_KIND_LABELS,
  EDIT_LOCKED_MESSAGE, LOCKS_URL, lockClearUrl, canManageLocks, editLockedOf, lockRows,
} from '../../lib/driverInstructionsView'

const props = defineProps({
  loadId: { type: String, default: '' },
  // The modal owns visibility: nothing is fetched for a closed modal.
  open: { type: Boolean, default: false },
})
// After a successful write: the load's review codes may have changed, so the tab
// refreshes the dashboard and its badges.
const emit = defineEmits(['changed'])

// A re-read waits for the server's own rate-con reading (up to a minute).
const REREAD_TIMEOUT_MS = 90000

const api = useApi()
const auth = useAuthStore()
const canSee = computed(() => canSeeDriverInstructions(auth.user?.role))
// The server's flag is off: every route answers 404 with no code.
const off = ref(false)
const visible = computed(() => canSee.value && !off.value)

const body = ref(null)
const loading = ref(false)
const busy = ref(false)
const errorText = ref('')
const noticeText = ref('')
const editing = ref(false)
const draft = ref(null)
// This person's instruction edits are locked (decision 37).
const locked = ref(false)
// Super Admins only: everyone locked, from the server.
const lockList = ref([])
const canLocks = computed(() => canManageLocks(auth.user?.role))
let seq = 0

const status = computed(() => statusView(body.value))
const reasons = computed(() => (Array.isArray(body.value?.reasons) ? body.value.reasons : []))
const compare = computed(() => pendingCompare(body.value))
const hidden = computed(() => hiddenFromDrivers(body.value?.payload))
const canReview = computed(() => canMarkReviewed(body.value))
const reviewedLine = computed(() => {
  const b = body.value
  if (!b || !b.reviewedAt) return ''
  const when = fmtAppInstant(b.reviewedAt, { fallback: '' })
  return `Last reviewed${b.reviewedBy ? ` by ${b.reviewedBy}` : ''}${when ? `, ${when}` : ''}.`
})

function resetMessages() {
  errorText.value = ''
  noticeText.value = ''
}

// One place every failure goes through: the flag-off 404 hides the section,
// everything else is a plain message from its code.
function fail(e) {
  const view = instructionsError(e)
  if (view.hidden) {
    off.value = true
    return
  }
  if (view.locked) {
    // The locked message replaces the edit controls; a Super Admin's list shows the lock.
    locked.value = true
    editing.value = false
    draft.value = null
    loadLocks()
    return
  }
  errorText.value = view.message
}

async function load() {
  const id = (props.loadId || '').trim()
  if (!canSee.value || !props.open || !id) return
  const mine = ++seq
  loading.value = true
  errorText.value = ''
  try {
    const answer = await api.get(instructionsUrl(id))
    if (mine !== seq) return
    off.value = false
    body.value = answer
    locked.value = editLockedOf(answer)
  } catch (e) {
    if (mine !== seq) return
    fail(e)
  } finally {
    if (mine === seq) loading.value = false
  }
}

// Every write: the button stays off while it runs, and the answer (the
// section's fresh state from the server) replaces what is shown.
async function write(run, done) {
  const id = (props.loadId || '').trim()
  if (!id || busy.value) return
  const mine = seq
  busy.value = true
  resetMessages()
  try {
    const answer = await run(id)
    if (mine !== seq) return
    body.value = answer
    locked.value = editLockedOf(answer)
    noticeText.value = done(answer)
    emit('changed')
    return true
  } catch (e) {
    if (mine !== seq) return
    fail(e)
    return false
  } finally {
    busy.value = false
  }
}

function startEdit() {
  resetMessages()
  draft.value = editDraftFrom(body.value?.payload)
  editing.value = true
}
function cancelEdit() {
  editing.value = false
  draft.value = null
  resetMessages()
}
async function save() {
  const ok = await write((id) => api.put(instructionsUrl(id), editBody(draft.value)), (answer) => doneText('Saved.', answer))
  if (ok) {
    editing.value = false
    draft.value = null
  }
}
function markReviewed() {
  return write((id) => api.post(instructionsUrl(id, 'review'), {}), (answer) => doneText('Marked reviewed.', answer))
}
async function decide(action) {
  const ok = await write(
    (id) => api.post(instructionsUrl(id, 'accept-pending'), { action }),
    () => (action === 'accept' ? 'The new reading is now what drivers see.' : 'Kept the current version.'),
  )
  // Someone else already decided: show the section as it stands now.
  if (ok === false && !off.value) {
    const message = errorText.value
    await load()
    errorText.value = message
  }
}
function reread() {
  return write((id) => api.post(instructionsUrl(id, 're-extract'), {}, { timeout: REREAD_TIMEOUT_MS }), (answer) => rereadResultText(answer?.result))
}

// Super Admins: the locked people (nothing is fetched for anyone else).
async function loadLocks() {
  if (!canLocks.value || !props.open) {
    lockList.value = []
    return
  }
  const mine = seq
  try {
    const answer = await api.get(LOCKS_URL)
    if (mine !== seq) return
    lockList.value = lockRows(answer, auth.user?.id)
  } catch (e) {
    if (mine !== seq) return
    fail(e)
  }
}
async function clearLock(userId) {
  if (busy.value) return
  const mine = seq
  busy.value = true
  resetMessages()
  try {
    const answer = await api.post(lockClearUrl(userId), {})
    if (mine !== seq) return
    lockList.value = lockRows(answer, auth.user?.id)
    noticeText.value = 'Lock cleared. That person can edit driver instructions again.'
  } catch (e) {
    if (mine !== seq) return
    fail(e)
    await loadLocks()
  } finally {
    busy.value = false
  }
}

watch(() => [props.loadId, props.open, canSee.value], ([id, open]) => {
  seq++
  body.value = null
  editing.value = false
  draft.value = null
  busy.value = false
  loading.value = false
  locked.value = false
  lockList.value = []
  resetMessages()
  if (open && id) {
    load()
    loadLocks()
  }
}, { immediate: true })
</script>

<style scoped>
.di-section { margin: 1rem 0; }
.di-chip {
  font-size: 0.6rem; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase;
  padding: 1px 6px; border-radius: 4px; border: 1px solid #e5e7eb; white-space: nowrap;
}
.di-chip-ok { background: #dcfce7; color: #166534; border-color: #bbf7d0; }
.di-chip-warn { background: #fef3c7; color: #92400e; border-color: #fde68a; }
.di-chip-bad { background: #fee2e2; color: #991b1b; border-color: #fecaca; }
.di-chip-muted { background: #f3f4f6; color: #4b5563; border-color: #e5e7eb; }
.di-msg { margin: 0 0 0.5rem; padding: 0.4rem 0.55rem; border-radius: 6px; font-size: 0.78rem; line-height: 1.35; }
.di-msg-error { background: #fef2f2; border: 1px solid #fecaca; color: #991b1b; }
.di-msg-ok { background: #f0fdf4; border: 1px solid #bbf7d0; color: #166534; }
.di-h { font-size: 0.7rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: #6b7280; margin-bottom: 0.25rem; }
.di-sub { font-size: 0.72rem; font-weight: 600; color: #374151; margin-top: 0.5rem; }
.di-box { border: 1px solid #e5e7eb; border-radius: 8px; padding: 0.5rem 0.6rem 0.6rem; display: flex; flex-direction: column; gap: 0.4rem; }
.di-row { display: flex; flex-direction: column; gap: 0.35rem; padding-bottom: 0.4rem; border-bottom: 1px dashed #f3f4f6; }
@media (min-width: 640px) {
  .di-row { flex-direction: row; flex-wrap: wrap; align-items: flex-start; }
  .di-row .di-text { flex: 1 1 14rem; }
  .di-row .di-note { flex-basis: 100%; }
}
.di-label { display: flex; flex-direction: column; gap: 0.2rem; font-size: 0.72rem; font-weight: 600; color: #374151; }
.di-select {
  height: 2.25rem; border: 1px solid #d1d5db; border-radius: 6px; padding: 0 0.5rem; font-size: 0.85rem; background: #fff;
}
.di-text {
  width: 100%; min-height: 2.25rem; border: 1px solid #d1d5db; border-radius: 6px; padding: 0.35rem 0.5rem; font-size: 0.85rem; resize: vertical;
}
.di-select:focus-visible, .di-text:focus-visible { outline: 2px solid #2563eb; outline-offset: 1px; }
.di-note { font-size: 0.72rem; color: #92400e; }
</style>
