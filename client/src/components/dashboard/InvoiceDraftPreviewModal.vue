<template>
  <Dialog :open="open" @update:open="onOpenChange">
    <DialogContent
      class="w-[97vw] max-w-[97vw] h-[96vh] max-h-[96vh] rounded-[14px] border-[#e8edf2] shadow-[0_8px_32px_rgba(0,0,0,0.12)] p-0 gap-0 overflow-hidden flex flex-col"
    >
      <!-- Extra right padding clears DialogContent's absolutely-positioned close X. -->
      <DialogHeader class="idp-header">
        <DialogTitle>Review invoice draft</DialogTitle>
        <DialogDescription>
          Nothing is sent yet — verify the recipient and attachments, then
          <strong>Approve &amp; Create Draft</strong> saves a Gmail draft for you to review and send.
        </DialogDescription>
      </DialogHeader>

      <div class="idp-body">
        <!-- Left: attachment preview (Invoice / Rate-con / POD) -->
        <div class="idp-pdf">
          <div class="idp-tabs" role="tablist" aria-label="Attachments">
            <button
              v-for="tab in tabs"
              :key="tab.key"
              type="button"
              role="tab"
              :aria-selected="activeTab === tab.key"
              class="idp-tab"
              :class="{ 'idp-tab-active': activeTab === tab.key }"
              @click="activeTab = tab.key"
            >
              {{ tab.label }}
            </button>
          </div>
          <div class="idp-stage">
            <div v-if="activeRateconLabel" class="idp-ratecon-label" :title="activeRateconLabel">{{ activeRateconLabel }}</div>
            <PdfZoomViewer v-if="stageSrc" :key="activeTab" :src="stageSrc" />
            <div v-else-if="activeTab === 'email'" class="idp-email">
              <div class="idp-email-head">
                <div><span class="idp-email-k">To</span> {{ recipient || pv.to || '—' }}</div>
                <div><span class="idp-email-k">Subject</span> {{ pv.subject || '—' }}</div>
              </div>
              <!-- Trusted server-rendered HTML (buildInvoiceEmailHtml esc()'s all dynamic fields). -->
              <div class="idp-email-body" v-html="emailHtml"></div>
            </div>
            <div v-else-if="activeTab === 'pod'" class="idp-pod-fallback">
              <template v-if="podUrl">
                <p>The POD is stored in Google Drive and can't be previewed inline here.</p>
                <a :href="podUrl" target="_blank" rel="noopener" class="idp-open-link">Open POD &#8599;</a>
              </template>
              <template v-else>
                <p>No POD is attached to this load.</p>
              </template>
            </div>
          </div>
        </div>

        <!-- Right: recipient + resolved routing -->
        <div class="idp-meta">
          <div class="idp-field">
            <label class="idp-label" for="idp-recipient">
              Recipient email
              <span class="idp-badge" :class="badge.cls">{{ badge.text }}</span>
            </label>
            <input
              id="idp-recipient"
              v-model="recipient"
              type="email"
              inputmode="email"
              autocomplete="off"
              class="idp-input"
              :class="{ 'is-invalid': recipient && !recipientValid }"
              :disabled="approving"
              placeholder="name@broker.com"
            />
            <p v-if="!recipient.trim()" class="idp-hint idp-hint-warn">A recipient is required before approving.</p>
            <p v-else-if="!recipientValid" class="idp-hint idp-hint-warn">That doesn't look like a valid email.</p>
            <p v-else-if="isEdited" class="idp-hint">Edited — the draft will be addressed to this address.</p>
          </div>

          <!-- No rate-con on file. Previously this only showed as a MISSING tab,
               which reads as nothing at all — so an invoice could be approved and
               sent without the rate confirmation the broker needs to pay it. -->
          <div v-if="!ratecons.length" class="idp-warn" role="status">
            <strong>No rate confirmation attached.</strong>
            This load has no rate-con on file, so the draft will go out with only the
            invoice and POD. Most brokers need the rate-con to process payment — attach
            it to the load first if this one does.
          </div>

          <dl class="idp-facts">
            <div class="idp-fact idp-fact-wide">
              <dt>Subject</dt>
              <dd>{{ pv.subject || '—' }}</dd>
            </div>
            <div class="idp-fact">
              <dt>Total</dt>
              <dd>
                {{ pv.total || '—' }}
                <span v-if="pv.totalSource" class="idp-muted">· from {{ pv.totalSource }}</span>
              </dd>
            </div>
            <div class="idp-fact">
              <dt>Broker</dt>
              <dd>{{ pv.brokerName || '—' }}</dd>
            </div>
            <div class="idp-fact">
              <dt>Invoice #</dt>
              <dd class="idp-mono">{{ pv.invoiceId || '—' }}</dd>
            </div>
            <div class="idp-fact">
              <dt>Order #</dt>
              <dd class="idp-mono">{{ pv.orderNumber || '—' }}</dd>
            </div>
          </dl>

          <div v-if="approveError" class="idp-error" role="alert">{{ approveError }}</div>
        </div>
      </div>

      <div class="idp-footer">
        <span class="idp-foot-note">Saves a Gmail draft — it is never auto-sent.</span>
        <div class="idp-foot-actions">
          <button type="button" class="idp-btn idp-btn-ghost" :disabled="approving" @click="onOpenChange(false)">Cancel</button>
          <button
            type="button"
            class="idp-btn idp-btn-primary"
            :disabled="approving || !recipientValid"
            @click="approve"
          >
            <span v-if="approving" class="idp-spinner" aria-hidden="true"></span>
            {{ approving ? 'Creating draft…' : 'Approve & Create Draft' }}
          </button>
        </div>
      </div>
    </DialogContent>
  </Dialog>
</template>

<script setup>
import { computed, ref, watch, onBeforeUnmount } from 'vue'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { useApi } from '../../composables/useApi'
import PdfZoomViewer from '../shared/PdfZoomViewer.vue'

const props = defineProps({
  open: { type: Boolean, default: false },
  loadId: { type: String, default: '' },
  // The dryRun response from POST /api/loads/:loadId/draft-invoice?dryRun=1.
  preview: { type: Object, default: () => ({}) },
  // POD row's drive_url: a same-origin /uploads/... path OR a Google Drive link.
  podUrl: { type: String, default: null },
  // True when an official draft already exists for this load (opened via
  // "Review"); re-approving mints a second draft, so gate it behind a confirm.
  alreadyDrafted: { type: Boolean, default: false },
})

const emit = defineEmits(['update:open', 'approved'])

const api = useApi()

// Invoice gen + IMAP draft can be slow; match RateConReviewModal's create timeout.
const APPROVE_TIMEOUT_MS = 60000

const pv = computed(() => props.preview || {})

// --- Recipient + source badge -----------------------------------------------
const recipient = ref('')
// The address the backend resolved (what we compare against to detect an edit).
const originalTo = computed(() => (pv.value.to || pv.value.documentsEmail || '').trim())
const isEdited = computed(() => recipient.value.trim() !== originalTo.value)
const recipientValid = computed(() => /\S+@\S+\.\S+/.test(recipient.value.trim()))
const badge = computed(() => {
  // A user edit always wins — it's a manual override regardless of the source.
  if (isEdited.value && recipient.value.trim()) return { text: 'manual', cls: 'idp-badge-blue' }
  const src = pv.value.documentsEmailSource
  if (src === 'ratecon') return { text: 'from rate-con ✓', cls: 'idp-badge-green' }
  if (src === 'default') return { text: 'default — please verify ⚠', cls: 'idp-badge-amber' }
  return { text: 'manual', cls: 'idp-badge-blue' }
})

// --- Attachment tabs + PDF blob URLs ----------------------------------------
const activeTab = ref('invoice')
// All rate-con files for this load. A load often has more than one (the original
// + a "Re:" reply / signed scan), and the billing email may live on only ONE of
// them — so show every file, not just the primary. Falls back to the single
// legacy field so an older cached dryRun response still previews. { base64, label, source }.
const ratecons = computed(() => {
  const list = Array.isArray(pv.value.ratecons) ? pv.value.ratecons.filter((rc) => rc && rc.base64) : []
  if (list.length) return list
  return pv.value.rateconPdfBase64 ? [{ base64: pv.value.rateconPdfBase64, label: 'Rate-con', source: '' }] : []
})
const hasEmail = computed(() => !!pv.value.emailHtml)
// The exact Gmail draft body from the dryRun response. Trusted server HTML —
// buildInvoiceEmailHtml esc()'s every dynamic field — so it's rendered via v-html.
const emailHtml = computed(() => pv.value.emailHtml || '')
const tabs = computed(() => {
  const t = [{ key: 'invoice', label: 'Invoice' }]
  // One tab per rate-con file; numbered only when there's more than one.
  ratecons.value.forEach((rc, i) => {
    t.push({ key: `ratecon:${i}`, label: ratecons.value.length > 1 ? `Rate-con ${i + 1}` : 'Rate-con' })
  })
  t.push({ key: 'pod', label: 'POD' })
  if (hasEmail.value) t.push({ key: 'email', label: 'Email message' })
  return t
})
// Index of the rate-con file the active tab points at, or -1 when not on one.
const rateconIndex = computed(() => (activeTab.value.startsWith('ratecon:') ? Number(activeTab.value.split(':')[1]) : -1))
// Filename caption over the PDF — only worth showing when there are several files.
const activeRateconLabel = computed(() => {
  const rc = rateconIndex.value >= 0 ? ratecons.value[rateconIndex.value] : null
  return ratecons.value.length > 1 && rc ? rc.label : ''
})
const podSameOrigin = computed(() => !!(props.podUrl && props.podUrl.startsWith('/uploads')))
const stageSrc = computed(() => {
  if (activeTab.value === 'invoice') return invoiceUrl.value
  if (rateconIndex.value >= 0) return rateconUrls.value[rateconIndex.value] || ''
  if (activeTab.value === 'pod') return podSameOrigin.value ? props.podUrl : ''
  return ''
})

// Object URLs must be revoked to avoid leaks — PdfZoomViewer needs a real URL
// (its fallback renders a raw data: URI as a plain link), so we decode the
// base64 to bytes and wrap in a Blob. Mirrors DocumentUpload.vue's PDF preview.
const invoiceUrl = ref('')
const rateconUrls = ref([]) // parallel to ratecons.value
let invoiceBlobUrl = null
let rateconBlobUrls = []

function b64ToBlobUrl(b64) {
  if (!b64) return ''
  try {
    const bin = atob(b64)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    return URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }))
  } catch {
    return ''
  }
}

function revokeBlobs() {
  if (invoiceBlobUrl) { URL.revokeObjectURL(invoiceBlobUrl); invoiceBlobUrl = null }
  rateconBlobUrls.forEach((u) => { if (u) URL.revokeObjectURL(u) })
  rateconBlobUrls = []
  invoiceUrl.value = ''
  rateconUrls.value = []
}

function buildBlobs() {
  revokeBlobs()
  invoiceBlobUrl = b64ToBlobUrl(pv.value.invoicePdfBase64)
  invoiceUrl.value = invoiceBlobUrl || ''
  rateconBlobUrls = ratecons.value.map((rc) => b64ToBlobUrl(rc.base64))
  rateconUrls.value = rateconBlobUrls.slice()
}

// Approve state — declared BEFORE the immediate watch below (which reads
// approveError) so its `immediate` run during setup doesn't hit a temporal-
// dead-zone ("Cannot access 'approveError' before initialization").
const approving = ref(false)
const approveError = ref('')

// Rebuild on open / new preview; revoke on close so a stale blob is never held.
watch(
  () => [props.open, props.preview],
  ([isOpen]) => {
    if (isOpen && props.preview) {
      buildBlobs()
      recipient.value = originalTo.value
      activeTab.value = 'invoice'
      approveError.value = ''
    } else if (!isOpen) {
      revokeBlobs()
    }
  },
  { immediate: true },
)

onBeforeUnmount(revokeBlobs)

// --- Approve ----------------------------------------------------------------
function onOpenChange(value) {
  if (value) return
  if (approving.value) return // don't orphan an in-flight draft create
  emit('update:open', false)
}

const DUPLICATE_APPROVE_MSG =
  'A draft already exists for this load. Approving creates ANOTHER Gmail draft with a new invoice number (the old draft is NOT removed). Continue?'

async function approve() {
  if (approving.value || !recipientValid.value) return
  // Re-approving an already-drafted load mints a SECOND draft + invoice number
  // (the first is not removed), so require an explicit confirm first.
  if (props.alreadyDrafted && !window.confirm(DUPLICATE_APPROVE_MSG)) return
  approving.value = true
  approveError.value = ''
  try {
    // Always pin the reviewed recipient. The approve call re-runs the whole
    // extraction pipeline (fresh Gemini), so sending the exact address the
    // dispatcher reviewed guarantees the draft goes where they saw — a
    // nondeterministic re-resolve can't redirect it. The backend classifies it
    // "manual" only when it differs from its own re-resolved value, so an
    // unchanged send still preserves the ratecon/default source badge.
    const body = { recipientEmail: recipient.value.trim() }
    const r = await api.post(
      `/api/loads/${encodeURIComponent(props.loadId)}/draft-invoice`,
      body,
      { timeout: APPROVE_TIMEOUT_MS },
    )
    emit('approved', { invoiceId: r.invoiceId, recipient: recipient.value.trim() || originalTo.value })
    emit('update:open', false)
  } catch (e) {
    approveError.value = (e && e.message) || 'Failed to create the draft.'
  } finally {
    approving.value = false
  }
}
</script>

<style scoped>
.idp-header {
  padding: 1rem 2.5rem 1rem 1.5rem;
  border-bottom: 1px solid #e8edf2;
  background: linear-gradient(to bottom, rgba(249, 250, 251, 0.8), #fff);
}

.idp-body {
  display: grid;
  grid-template-columns: 1fr 380px;
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden;
}

/* Left PDF column: tabs on top, a relatively-positioned stage the absolutely
   positioned PdfZoomViewer fills (inset:0). */
.idp-pdf {
  position: relative;
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: #f1f5f9;
  border-right: 1px solid #e8edf2;
  overflow: hidden;
}
.idp-tabs {
  display: flex;
  gap: 0.35rem;
  padding: 0.6rem 0.75rem;
  background: #fff;
  border-bottom: 1px solid #e8edf2;
  flex-shrink: 0;
}
.idp-tab {
  padding: 0.4rem 0.9rem;
  font-family: inherit;
  font-size: 0.78rem;
  font-weight: 600;
  color: #475569;
  background: #f1f5f9;
  border: 1px solid #e2e8f0;
  border-radius: 999px;
  cursor: pointer;
  transition: all 0.15s;
}
.idp-tab:hover { background: #e2e8f0; }
.idp-tab-active {
  color: #fff;
  background: #0f2847;
  border-color: #0f2847;
}
.idp-stage {
  position: relative;
  flex: 1 1 auto;
  min-height: 0;
}
/* Floating filename caption over the PDF (shown when a load has multiple rate-cons). */
.idp-ratecon-label {
  position: absolute;
  top: 0.5rem;
  left: 50%;
  transform: translateX(-50%);
  z-index: 5;
  max-width: 80%;
  padding: 0.3rem 0.8rem;
  background: rgba(15, 40, 71, 0.92);
  color: #fff;
  font-size: 0.72rem;
  font-weight: 600;
  border-radius: 999px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  pointer-events: none;
}
.idp-pod-fallback {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.9rem;
  padding: 1.5rem;
  text-align: center;
  color: #64748b;
  font-size: 0.85rem;
}
.idp-open-link {
  padding: 0.5rem 1rem;
  border-radius: 8px;
  background: #2563eb;
  color: #fff;
  font-size: 0.82rem;
  font-weight: 600;
  text-decoration: none;
}
.idp-open-link:hover { background: #1d4ed8; }

/* Email-message preview (the exact Gmail draft body). */
.idp-email {
  position: absolute;
  inset: 0;
  overflow-y: auto;
  padding: 1rem 1.25rem 1.5rem;
  background: #f8fafc;
}
.idp-email-head {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  max-width: 720px;
  margin: 0 auto 1rem;
  padding: 0.7rem 0.9rem;
  background: #fff;
  border: 1px solid #e8edf2;
  border-radius: 10px;
  font-size: 0.85rem;
  color: #1a1d27;
  word-break: break-word;
}
.idp-email-k {
  font-size: 0.62rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: #94a3b8;
  margin-right: 0.5rem;
}
.idp-email-body {
  max-width: 720px;
  margin: 0 auto;
  padding: 1.5rem 1.75rem;
  background: #fff;
  border: 1px solid #e8edf2;
  border-radius: 10px;
}
/* v-html email content is unscoped — keep its embedded logo/images in bounds. */
.idp-email-body :deep(img) { max-width: 100%; height: auto; }

/* Right details column. */
.idp-meta {
  padding: 1.25rem 1.5rem;
  overflow-y: auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
}
.idp-field { display: flex; flex-direction: column; gap: 0.35rem; }
.idp-label {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  flex-wrap: wrap;
  font-size: 0.72rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: #64748b;
}
.idp-badge {
  padding: 1px 7px;
  font-size: 0.62rem;
  font-weight: 700;
  text-transform: none;
  letter-spacing: 0;
  border-radius: 999px;
  border: 1px solid transparent;
  white-space: nowrap;
}
.idp-badge-green { background: #f0fdf4; border-color: #bbf7d0; color: #166534; }
.idp-badge-amber { background: #fffbeb; border-color: #fde68a; color: #92400e; }
.idp-badge-blue { background: #eff6ff; border-color: #bfdbfe; color: #1d4ed8; }

.idp-input {
  width: 100%;
  padding: 0.55rem 0.7rem;
  font-family: inherit;
  font-size: 0.9rem;
  color: #1a1d27;
  background: #fff;
  border: 1px solid #d1d5db;
  border-radius: 8px;
}
.idp-input:focus { outline: none; border-color: #38bdf8; box-shadow: 0 0 0 3px rgba(56, 189, 248, 0.12); }
.idp-input:disabled { background: #f9fafb; color: #6b7085; }
.idp-input.is-invalid { border-color: #dc2626; background: #fffafa; }
.idp-hint { font-size: 0.72rem; color: #64748b; margin: 0; }
.idp-hint-warn { color: #b45309; }

.idp-facts {
  margin: 0;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.75rem 1rem;
}
.idp-fact { display: flex; flex-direction: column; gap: 0.2rem; min-width: 0; }
.idp-fact-wide { grid-column: span 2; }
.idp-fact dt {
  font-size: 0.66rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: #94a3b8;
}
.idp-fact dd {
  margin: 0;
  font-size: 0.88rem;
  color: #1a1d27;
  word-break: break-word;
}
.idp-mono { font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 0.82rem; }
.idp-muted { color: #94a3b8; font-size: 0.78rem; font-weight: 500; }

.idp-error {
  padding: 0.6rem 0.8rem;
  border-radius: 8px;
  font-size: 0.8rem;
  line-height: 1.45;
  background: #fef2f2;
  border: 1px solid #fecaca;
  color: #b91c1c;
}

/* Amber, not red — a missing rate-con is a "check this before you approve",
   not a failure; the draft is still valid without one. */
.idp-warn {
  padding: 0.6rem 0.8rem;
  border-radius: 8px;
  font-size: 0.8rem;
  line-height: 1.45;
  background: #fffbeb;
  border: 1px solid #fde68a;
  color: #92400e;
}

.idp-warn strong {
  display: block;
  font-weight: 600;
  margin-bottom: 0.15rem;
}

.idp-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  flex-wrap: wrap;
  padding: 0.85rem 1.5rem;
  border-top: 1px solid #e8edf2;
  background: #fafafa;
  flex-shrink: 0;
}
.idp-foot-note { font-size: 0.75rem; color: #64748b; }
.idp-foot-actions { display: flex; gap: 0.5rem; margin-left: auto; }
.idp-btn {
  display: inline-flex;
  align-items: center;
  gap: 0.45rem;
  padding: 0.55rem 1.1rem;
  font-family: inherit;
  font-size: 0.85rem;
  font-weight: 600;
  border-radius: 8px;
  cursor: pointer;
}
.idp-btn:disabled { opacity: 0.6; cursor: not-allowed; }
.idp-btn-ghost { border: 1px solid #d1d5db; background: #fff; color: #374151; }
.idp-btn-ghost:hover:not(:disabled) { background: #f9fafb; }
.idp-btn-primary { border: 1px solid #0f2847; background: #0f2847; color: #fff; }
.idp-btn-primary:hover:not(:disabled) { background: #17385f; }
.idp-spinner {
  width: 14px;
  height: 14px;
  border: 2px solid rgba(255, 255, 255, 0.45);
  border-top-color: #fff;
  border-radius: 50%;
  animation: idp-spin 0.7s linear infinite;
}
@keyframes idp-spin { to { transform: rotate(360deg); } }

/* Mobile: stack the PDF over the details; let the body scroll as a column. */
@media (max-width: 900px) {
  .idp-body {
    grid-template-columns: 1fr;
    display: flex;
    flex-direction: column;
    overflow-y: auto;
  }
  .idp-pdf {
    border-right: none;
    border-bottom: 1px solid #e8edf2;
    min-height: 55vh;
  }
  .idp-stage { min-height: 320px; }
  .idp-meta { overflow-y: visible; }
}
@media (max-width: 560px) {
  .idp-facts { grid-template-columns: 1fr; }
  .idp-fact-wide { grid-column: span 1; }
  .idp-foot-actions { width: 100%; }
  .idp-foot-actions .idp-btn { flex: 1; justify-content: center; }
}
</style>
