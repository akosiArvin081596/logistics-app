<template>
  <section class="card invites-panel" data-test="invites-panel" :aria-labelledby="titleId">
    <div class="panel-head">
      <div class="panel-heading">
        <h3 :id="titleId" class="admin-section-title">
          <span class="section-dot" style="background: var(--accent);"></span>
          Personal Invite Links
        </h3>
        <p class="panel-hint">An invite link carries one investor's own payment terms into the application. The plain /invest page keeps the standard contract.</p>
      </div>
      <div class="panel-tools">
        <span v-if="store.hasLoaded && store.isLoading" class="status-pill">Refreshing…</span>
        <label class="filter">
          <span class="filter-label">Status</span>
          <select v-model="statusFilter" class="filter-select" data-test="invites-status-filter">
            <option v-for="value in INVITE_STATUS_FILTERS" :key="value" :value="value">{{ FILTER_LABELS[value] }}</option>
          </select>
        </label>
        <button type="button" class="btn btn-primary btn-sm" data-test="invite-new" @click="openCreate">+ New invite</button>
      </div>
    </div>

    <p v-if="notice" class="panel-msg panel-msg-ok" role="status">
      <span>{{ notice }}</span>
      <button type="button" class="msg-dismiss" @click="notice = ''">Dismiss</button>
    </p>

    <SkeletonLoader v-if="!store.hasLoaded && !store.loadError" :rows="3" :cols="6" />
    <div v-else-if="!store.hasLoaded" class="panel-msg panel-msg-error" role="alert">
      <span>Couldn't load the invites ({{ store.loadError }}).</span>
      <button type="button" class="msg-dismiss" :disabled="store.isLoading" @click="store.refresh()">Retry</button>
    </div>
    <template v-else>
      <p v-if="store.loadError" class="panel-msg panel-msg-error" role="alert">
        <span>Couldn't refresh the invites ({{ store.loadError }}). These are the invites as last loaded.</span>
        <button type="button" class="msg-dismiss" :disabled="store.isLoading" @click="store.refresh()">Retry</button>
      </p>
      <EmptyState v-if="!store.invites.length">{{ emptyText }}</EmptyState>
      <div v-else class="table-wrap">
        <table class="inv-table">
          <thead>
            <tr>
              <th scope="col">Invitee</th>
              <th scope="col">Terms</th>
              <th scope="col">Status</th>
              <th scope="col">Created</th>
              <th scope="col">Expires</th>
              <th scope="col"><span class="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="inv in store.invites" :key="inv.id" :data-invite-id="inv.id">
              <td>
                <div class="name-cell">{{ inv.inviteeName || '—' }}</div>
                <div v-if="inv.inviteeEmail" class="sub-line">{{ inv.inviteeEmail }}</div>
              </td>
              <td>
                <PaymentTermsSummary compact :display="inv.display" :terms="inv.paymentTerms" :is-default="inv.isStandard" />
              </td>
              <td>
                <span :class="['chip', `chip-${inv.status}`]" :data-status="inv.status">{{ STATUS_LABELS[inv.status] || inv.status }}</span>
                <div v-if="inv.status === 'used' && inv.usedAt" class="sub-line" :title="fmtTimestamp(inv.usedAt)">{{ fmtDay(inv.usedAt) }}</div>
                <div v-if="inv.status === 'revoked' && inv.revokedAt" class="sub-line" :title="fmtTimestamp(inv.revokedAt)">{{ fmtDay(inv.revokedAt) }}</div>
                <div v-if="inv.status === 'revoked' && inv.revokeReason" class="sub-line reason" :title="inv.revokeReason">{{ inv.revokeReason }}</div>
              </td>
              <td class="date-cell" :title="fmtTimestamp(inv.createdAt)">{{ fmtDay(inv.createdAt) }}</td>
              <td class="date-cell" :class="{ 'is-expired': inv.status === 'expired' }" :title="isOpen(inv) ? fmtTimestamp(inv.expiresAt) : undefined">
                {{ isOpen(inv) ? fmtDay(inv.expiresAt) : '—' }}
              </td>
              <td class="actions-cell">
                <div v-if="isOpen(inv)" class="row-actions">
                  <button type="button" class="btn-row" data-test="invite-edit" @click="openEdit(inv)">Edit terms</button>
                  <button type="button" class="btn-row" data-test="invite-reissue" @click="askReissue(inv)">New link</button>
                  <button type="button" class="btn-row btn-row-danger" data-test="invite-revoke" @click="askRevoke(inv)">Revoke</button>
                  <span class="preview-group" role="group" :aria-label="`Preview agreements for ${inv.inviteeName || 'this invite'}`">
                    <span class="preview-label" aria-hidden="true">Preview</span>
                    <button
                      v-for="doc in PREVIEW_DOCS"
                      :key="doc.key"
                      type="button"
                      class="btn-row"
                      :data-test="`invite-preview-${doc.key}`"
                      :aria-label="`Preview the ${doc.name}`"
                      @click="openPreview(inv, doc)"
                    >{{ doc.short }}</button>
                  </span>
                </div>
                <RouterLink
                  v-else-if="inv.status === 'used'"
                  class="btn-row"
                  data-test="invite-view-application"
                  :to="applicationLink(inv)"
                >View application</RouterLink>
                <span v-else class="sub-line">—</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>

    <InviteModal :open="formState.open" :title="formTitle" :close-on-backdrop="false" @close="closeForm">
      <InviteTermsForm
        v-if="formState.open"
        :key="formState.key"
        :invite="formInvite"
        @created="onCreated"
        @saved="onSaved"
        @cancel="closeForm"
      />
    </InviteModal>

    <InviteLinkDialog
      :open="!!link"
      :invite-path="link?.invitePath || ''"
      :invitee-name="link?.name || ''"
      :reissued="!!link?.reissued"
      @close="link = null"
    />

    <InviteModal :open="preview.open" wide :title="previewTitle" @close="closePreview">
      <p v-if="preview.loading" class="preview-status" role="status">Preparing the preview…</p>
      <div v-else-if="preview.error" class="panel-msg panel-msg-error" role="alert">
        <span>{{ preview.error }}</span>
        <button type="button" class="msg-dismiss" @click="retryPreview">Try again</button>
      </div>
      <template v-else-if="preview.url">
        <iframe :src="preview.url" class="preview-frame" :title="previewTitle"></iframe>
        <a :href="preview.url" class="preview-open" target="_blank" rel="noopener">Open in a new tab</a>
      </template>
      <p class="preview-note">Rendered for a sample applicant ("Sample Investor LLC") with this invite's terms.</p>
    </InviteModal>

    <ConfirmModal
      :open="!!reissueTarget"
      title="Create a new link?"
      :message="`The current link for ${reissueTarget?.inviteeName || 'this invite'} stops working immediately, including for anyone part-way through the application.`"
      :confirm-text="reissueBusy ? 'Creating…' : 'Create new link'"
      :confirm-disabled="reissueBusy"
      @confirm="confirmReissue"
      @cancel="cancelReissue"
    >
      <template v-if="reissueError" #default>
        <p class="confirm-error" role="alert">{{ reissueError }}</p>
      </template>
    </ConfirmModal>

    <ConfirmModal
      :open="!!revokeTarget"
      title="Revoke this invite?"
      :message="`The link for ${revokeTarget?.inviteeName || 'this invite'} stops working immediately, including for anyone part-way through the application. This cannot be undone.`"
      :confirm-text="revokeBusy ? 'Revoking…' : 'Revoke invite'"
      :confirm-disabled="revokeBusy || revokeReason.length > REVOKE_REASON_MAX"
      :danger="true"
      @confirm="confirmRevoke"
      @cancel="cancelRevoke"
    >
      <label class="form-label" :for="revokeReasonId">Reason (optional)</label>
      <textarea
        :id="revokeReasonId"
        v-model="revokeReason"
        class="form-input form-textarea"
        data-test="invite-revoke-reason"
        rows="2"
        :maxlength="REVOKE_REASON_MAX"
        :aria-describedby="revokeCounterId"
      ></textarea>
      <span :id="revokeCounterId" class="reason-counter">{{ revokeReason.length }}/{{ REVOKE_REASON_MAX }}</span>
      <p v-if="revokeError" class="confirm-error" role="alert">{{ revokeError }}</p>
    </ConfirmModal>
  </section>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref, useId } from 'vue'
import { INVITE_STATUS_FILTERS, useInvestorInvitesStore } from '../../stores/investorInvites'
import { useSocketRefresh } from '../../composables/useSocketRefresh'
import { fmtTimestamp } from '../../utils/datetime'
import EmptyState from '../shared/EmptyState.vue'
import SkeletonLoader from '../shared/SkeletonLoader.vue'
import ConfirmModal from '../shared/ConfirmModal.vue'
import InviteModal from './InviteModal.vue'
import InviteTermsForm from './InviteTermsForm.vue'
import InviteLinkDialog from './InviteLinkDialog.vue'
import PaymentTermsSummary from './PaymentTermsSummary.vue'

const store = useInvestorInvitesStore()
useSocketRefresh('investor-invites:changed', () => store.refresh())

const uid = useId()
const titleId = `invites-title-${uid}`
const revokeReasonId = `invite-revoke-reason-${uid}`
const revokeCounterId = `invite-revoke-counter-${uid}`

const REVOKE_REASON_MAX = 300
const FILTER_LABELS = { all: 'All', active: 'Active', used: 'Used', revoked: 'Revoked', expired: 'Expired' }
const STATUS_LABELS = { active: 'Active', used: 'Used', revoked: 'Revoked', expired: 'Expired' }
const PREVIEW_DOCS = [
  { key: 'master_agreement', name: 'Master Agreement', short: 'Master' },
  { key: 'vehicle_lease', name: 'Vehicle Lease', short: 'Lease' },
]

const notice = ref('')

const statusFilter = computed({
  get: () => store.status,
  set: (value) => { store.refresh(value) },
})

const emptyText = computed(() =>
  store.status === 'all'
    ? 'No invites yet. Create one to offer an investor their own payment terms.'
    : `No ${FILTER_LABELS[store.status].toLowerCase()} invites.`,
)

// An expired invite is still editable and can take a new link; only a used or
// revoked one is final.
function isOpen(inv) {
  return inv.status === 'active' || inv.status === 'expired'
}

function applicationLink(inv) {
  return inv.applicationId
    ? { path: '/investor-applications', query: { application: String(inv.applicationId) } }
    : { path: '/investor-applications' }
}

const dayFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Chicago', month: 'short', day: 'numeric', year: 'numeric',
})
function fmtDay(iso) {
  const dt = new Date(iso || '')
  return iso && !isNaN(dt.getTime()) ? dayFormat.format(dt) : '—'
}

// ---- Create / edit -------------------------------------------------------
const formState = reactive({ open: false, inviteId: null, key: 0 })
const formSnapshot = ref(null)
// The live row while the form is open, so a status change (used, revoked)
// reaches the form; the snapshot covers a row the current filter has dropped.
const formInvite = computed(() => {
  if (formState.inviteId == null) return null
  return store.invites.find((i) => i.id === formState.inviteId) || formSnapshot.value
})
const formTitle = computed(() => {
  const inv = formInvite.value
  if (!inv) return 'New invite'
  const who = inv.inviteeName || 'this invite'
  return inv.status === 'used' || inv.status === 'revoked' ? `Terms for ${who}` : `Edit terms for ${who}`
})

function openCreate() {
  notice.value = ''
  formState.inviteId = null
  formSnapshot.value = null
  formState.key += 1
  formState.open = true
}

function openEdit(inv) {
  notice.value = ''
  formState.inviteId = inv.id
  formSnapshot.value = inv
  formState.key += 1
  formState.open = true
}

function closeForm() {
  formState.open = false
}

const link = ref(null)

function onCreated(data) {
  closeForm()
  link.value = { invitePath: data.invitePath, name: data.invite?.inviteeName || '', reissued: false }
  notice.value = `Invite created for ${data.invite?.inviteeName || 'the investor'}.`
}

function onSaved({ invite, previousRevision }) {
  closeForm()
  const who = invite?.inviteeName || 'the investor'
  if (invite && invite.termsRevision !== previousRevision) {
    notice.value = invite.firstOpenedAt
      ? `Terms saved for ${who}. Anyone part-way through this application will be asked to review and sign the agreements again.`
      : `Terms saved for ${who}.`
  } else {
    notice.value = `Invite saved for ${who}. The payment terms did not change.`
  }
}

// ---- New link ------------------------------------------------------------
const reissueTarget = ref(null)
const reissueBusy = ref(false)
const reissueError = ref('')

const ACTION_REFUSALS = {
  INVITE_LOCKED: 'This invite has already been used for an application.',
  INVITE_REVOKED: 'This invite has been revoked.',
  INVITE_NOT_FOUND: 'This invite no longer exists.',
}

function askReissue(inv) {
  notice.value = ''
  reissueError.value = ''
  reissueTarget.value = inv
}

function cancelReissue() {
  if (reissueBusy.value) return
  reissueTarget.value = null
}

async function confirmReissue() {
  const inv = reissueTarget.value
  if (!inv || reissueBusy.value) return
  reissueBusy.value = true
  reissueError.value = ''
  try {
    const data = await store.reissue(inv.id)
    reissueTarget.value = null
    link.value = { invitePath: data.invitePath, name: data.invite?.inviteeName || inv.inviteeName || '', reissued: true }
  } catch (err) {
    reissueError.value = ACTION_REFUSALS[err?.code] || err?.message || 'A new link could not be created.'
    store.refresh()
  } finally {
    reissueBusy.value = false
  }
}

// ---- Revoke --------------------------------------------------------------
const revokeTarget = ref(null)
const revokeReason = ref('')
const revokeBusy = ref(false)
const revokeError = ref('')

function askRevoke(inv) {
  notice.value = ''
  revokeReason.value = ''
  revokeError.value = ''
  revokeTarget.value = inv
}

function cancelRevoke() {
  if (revokeBusy.value) return
  revokeTarget.value = null
}

async function confirmRevoke() {
  const inv = revokeTarget.value
  if (!inv || revokeBusy.value) return
  revokeBusy.value = true
  revokeError.value = ''
  try {
    await store.revoke(inv.id, revokeReason.value.trim())
    revokeTarget.value = null
    notice.value = `Invite revoked for ${inv.inviteeName || 'the investor'}. Its link no longer works.`
  } catch (err) {
    revokeError.value = ACTION_REFUSALS[err?.code] || err?.message || 'The invite could not be revoked.'
    store.refresh()
  } finally {
    revokeBusy.value = false
  }
}

// ---- Preview -------------------------------------------------------------
const preview = reactive({ open: false, loading: false, error: '', url: '', invite: null, doc: null })
let previewTicket = 0
let previewAbort = null

const previewTitle = computed(() => {
  const doc = preview.doc?.name || 'Agreement'
  const who = preview.invite?.inviteeName
  return who ? `${doc} preview for ${who}` : `${doc} preview`
})

function releasePreviewUrl() {
  if (preview.url) URL.revokeObjectURL(preview.url)
  preview.url = ''
}

function previewErrorText(err) {
  if (err?.status === 404) return 'This invite no longer exists.'
  if (err?.status === 429) return 'Too many previews in a short time. Wait a minute, then try again.'
  return err?.message || 'The preview could not be generated.'
}

async function openPreview(inv, doc) {
  notice.value = ''
  previewAbort?.abort()
  releasePreviewUrl()
  const ticket = ++previewTicket
  const controller = new AbortController()
  previewAbort = controller
  Object.assign(preview, { open: true, loading: true, error: '', invite: inv, doc })
  try {
    const blob = await store.previewPdf(inv.id, doc.key, { signal: controller.signal })
    if (ticket !== previewTicket) return
    preview.url = URL.createObjectURL(blob)
  } catch (err) {
    if (ticket !== previewTicket) return
    preview.error = previewErrorText(err)
  } finally {
    if (ticket === previewTicket) preview.loading = false
  }
}

function retryPreview() {
  if (preview.invite && preview.doc) openPreview(preview.invite, preview.doc)
}

function closePreview() {
  previewTicket += 1
  previewAbort?.abort()
  previewAbort = null
  releasePreviewUrl()
  Object.assign(preview, { open: false, loading: false, error: '', invite: null, doc: null })
}

onMounted(() => { store.refresh() })
onBeforeUnmount(closePreview)
</script>

<style scoped>
.card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 1.25rem;
  margin-bottom: 1.25rem;
}
.panel-head {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  align-items: flex-start;
  gap: 0.75rem 1rem;
  margin-bottom: 0.75rem;
}
.panel-heading { min-width: 0; flex: 1 1 320px; }
.admin-section-title {
  display: flex; align-items: center; gap: 0.5rem;
  font-weight: 700; font-size: 0.88rem; margin: 0 0 0.25rem;
}
.section-dot { width: 8px; height: 8px; border-radius: 50%; }
.panel-hint { margin: 0; font-size: 0.75rem; color: var(--text-dim); }
.panel-tools { display: flex; align-items: center; gap: 0.6rem; flex-wrap: wrap; }
.status-pill {
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.7rem;
  padding: 0.25rem 0.6rem;
  border-radius: 20px;
  border: 1px solid var(--border);
  color: var(--text-dim);
}
.filter { display: inline-flex; align-items: center; gap: 0.4rem; }
.filter-label { font-size: 0.72rem; font-weight: 600; color: var(--text-dim); }
.filter-select {
  padding: 0.3rem 0.5rem;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface);
  color: var(--text);
  font-family: inherit;
  font-size: 0.78rem;
}
.filter-select:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }

.panel-msg {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.75rem;
  margin: 0 0 0.75rem;
  padding: 0.55rem 0.75rem;
  border-radius: 8px;
  font-size: 0.78rem;
  line-height: 1.45;
}
.panel-msg-ok { background: var(--accent-dim); color: #0369a1; }
.panel-msg-error { background: var(--danger-dim); color: #b91c1c; }
.msg-dismiss {
  flex-shrink: 0;
  background: none;
  border: none;
  padding: 0;
  font: inherit;
  font-weight: 700;
  color: inherit;
  text-decoration: underline;
  cursor: pointer;
}
.msg-dismiss:disabled { opacity: 0.6; cursor: default; }

.table-wrap { overflow-x: auto; }
.inv-table {
  width: 100%; border-collapse: separate; border-spacing: 0;
  font-size: 0.82rem;
}
.inv-table th {
  text-align: left; padding: 0.6rem 0.5rem; font-weight: 600;
  color: var(--text-dim); border-bottom: 2px solid var(--border);
  font-size: 0.68rem; text-transform: uppercase; letter-spacing: 0.06em;
  white-space: nowrap;
}
.inv-table td {
  padding: 0.65rem 0.5rem; border-bottom: 1px solid var(--bg); vertical-align: top;
}
.inv-table tbody tr:last-child td { border-bottom: none; }
.name-cell { font-weight: 600; }
.sub-line { font-size: 0.72rem; color: var(--text-dim); margin-top: 0.15rem; overflow-wrap: anywhere; }
.reason { max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.date-cell { white-space: nowrap; font-size: 0.78rem; }
.date-cell.is-expired { color: #b45309; }

.chip {
  display: inline-flex; align-items: center;
  padding: 0.2rem 0.6rem; border-radius: 12px;
  font-size: 0.68rem; font-weight: 600;
  font-family: 'JetBrains Mono', monospace; letter-spacing: 0.02em;
}
.chip-active { background: var(--accent-dim); color: #0369a1; }
.chip-used { background: rgba(22, 163, 74, 0.1); color: #15803d; }
.chip-revoked { background: var(--danger-dim); color: #b91c1c; }
.chip-expired { background: var(--amber-dim); color: #b45309; }

.actions-cell { text-align: right; }
.row-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 0.35rem;
}
.btn-row {
  display: inline-flex;
  align-items: center;
  padding: 0.3rem 0.6rem; font-size: 0.7rem; border-radius: 6px;
  border: 1px solid var(--border); background: var(--surface);
  cursor: pointer; font-family: inherit; font-weight: 500;
  color: var(--text-dim); transition: all 0.15s;
  white-space: nowrap;
  text-decoration: none;
}
.btn-row:hover { background: var(--blue-dim); color: var(--blue); border-color: var(--blue-dim); }
.btn-row-danger:hover { background: var(--danger-dim); color: var(--danger); border-color: var(--danger-dim); }
.btn-row:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.preview-group { display: inline-flex; align-items: center; gap: 0.25rem; }
.preview-label { font-size: 0.68rem; color: var(--text-dim); margin-left: 0.25rem; }

.preview-status { margin: 2rem 0; text-align: center; font-size: 0.82rem; color: var(--text-dim); }
.preview-frame {
  width: 100%;
  height: 70vh;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg);
}
.preview-open { align-self: flex-start; margin-top: 0.5rem; font-size: 0.78rem; color: #0369a1; }
.preview-note { margin: 0.5rem 0 0; font-size: 0.72rem; color: var(--text-dim); }

.confirm-error { margin: 0.5rem 0 0; font-size: 0.78rem; color: #b91c1c; }
.reason-counter { display: block; text-align: right; font-size: 0.7rem; color: var(--text-dim); margin-top: 0.2rem; }
</style>
