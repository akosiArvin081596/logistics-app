<template>
  <Dialog :open="open" @update:open="onOpenChange">
    <DialogContent
      class="w-[97vw] max-w-[97vw] h-[96vh] max-h-[96vh] rounded-[14px] border-[#e8edf2] shadow-[0_8px_32px_rgba(0,0,0,0.12)] p-0 gap-0 overflow-hidden flex flex-col"
    >
      <!-- Extra right padding clears DialogContent's absolutely-positioned close X. -->
      <DialogHeader class="idp-header">
        <DialogTitle>Review invoice draft</DialogTitle>
        <DialogDescription>
          Nothing is sent yet — <strong>edit anything that's wrong</strong> and the preview re-renders, then
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
            <!-- Reuses the rate-con caption pill rather than inventing a second
                 floating-status style: same slot, same non-interactive treatment,
                 and the two can never collide (that caption only renders on a
                 rate-con tab, this only on the invoice). -->
            <div v-else-if="activeTab === 'invoice' && (previewing || previewPending)" class="idp-ratecon-label">
              {{ previewing ? 'Updating preview…' : 'Edits not rendered yet' }}
            </div>
            <!-- ⚠️ Keyed on activeTab ONLY — deliberately NOT on the src, so a
                 re-rendered invoice swaps the document in place instead of
                 remounting. Both were measured under production conditions and
                 both are correct; in-place wins on the thing the user sees:
                 sampling every 100 ms across an edit, in-place never leaves the
                 pane empty (0/40 samples) while a remount blanks it for ~200 ms
                 before the spinner resolves.
                 ⚠️ The correctness of BOTH depends on app.config.errorHandler
                 (src/main.js) existing. vue-pdf-embed's teardown throws
                 "destroy is not a function" on every document swap; Vue routes a
                 lifecycle error to that handler and carries on, but with NO handler
                 installed the throw aborts the rest of the patch and leaves sibling
                 subtrees stale — the footer keeps a disabled Approve button and a
                 stale reason while the component's own state says otherwise, i.e.
                 the reviewer silently stops updating. Verified by removing the
                 handler and reproducing exactly that. If that handler is ever
                 narrowed, re-test this pane. -->
            <PdfZoomViewer v-if="stageSrc" :key="activeTab" :src="stageSrc" />
            <!-- The invoice tab now has a genuine empty state: a load with no
                 derivable total arrives with invoicePdfBase64:"" (the server
                 renders no $0.00 PDF), so there is nothing to show until the
                 dispatcher supplies the missing figures. -->
            <div v-else-if="activeTab === 'invoice'" class="idp-pod-fallback">
              <template v-if="previewing">
                <p>Rendering the invoice preview…</p>
              </template>
              <template v-else-if="!formValid">
                <p>No invoice preview yet — fill in the highlighted fields on the right and it will render here.</p>
                <p v-if="firstFieldError" class="idp-hint idp-hint-warn">{{ firstFieldError }}</p>
              </template>
              <template v-else-if="previewError">
                <p>{{ previewError }}</p>
              </template>
              <template v-else>
                <p>No invoice preview yet.</p>
              </template>
            </div>
            <div v-else-if="activeTab === 'email'" class="idp-email">
              <div class="idp-email-head">
                <div><span class="idp-email-k">To</span> {{ recipient || pv.to || '—' }}</div>
                <div><span class="idp-email-k">Subject</span> {{ previewSubject || '—' }}</div>
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

        <!-- Right: the eight editable invoice fields, risk-descending.
             Every one of these prints on the PDF the broker receives; before
             this form only the recipient could be corrected, so a misread order
             number or a stale sheet rate had no path except "fix the source and
             re-run" — which for a delivered load in a closed month is no path. -->
        <div class="idp-meta">
          <!-- 1. Recipient email — position, badge and copy deliberately unchanged. -->
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
              :class="{ 'is-invalid': !!(recipient && fieldErrors.recipient), 'is-edited': isEdited }"
              :aria-invalid="!!fieldErrors.recipient"
              :disabled="approving"
              placeholder="name@broker.com"
              @input="onFieldInput"
            />
            <p v-if="fieldErrors.recipient" class="idp-hint idp-hint-warn">{{ fieldErrors.recipient }}</p>
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

          <!-- How the attached rate-con was identified. A file matched by READING
               PDFs was inferred, not pointed at, so the reviewer is told — the
               same principle as the Order # banner below, applied to the
               riskier of the two substitutions. -->
          <div v-if="rateconInferred" class="idp-warn" role="status">
            <strong>This rate confirmation was matched by its contents.</strong>
            Its file name does not carry this load number, so it was identified by
            reading the document. Check the Rate-con tab shows the right load before
            approving — it is attached to the email.
          </div>

          <!-- The Order # silently became our own load id. This used to be a
               server-side console.log ONLY, so the field below rendered populated
               and completely ordinary, and a wrong number went to Bison AP on
               load 30080873. Say it where the person approving is looking. -->
          <div v-if="orderNumberIsFallback" class="idp-warn" role="status">
            <strong>The Order # could not be read from the rate confirmation.</strong>
            What is shown below is <em>our</em> load number, not the broker's order
            number — Bison matches payment on theirs, so an invoice sent this way is
            likely to sit unpaid. Enter the Order # and PO # from the rate con.
          </div>

          <!-- Trailer is a SAFETY check, not a presentation field, so it is not
               editable here — but approve is refused with a 409 when it mismatches,
               and Gemini is nondeterministic enough that a clean preview can still
               be followed by a refusal. Say so before anyone edits eight fields. -->
          <!-- ⚠️ The inline values are NOT <strong>: `.idp-warn strong` is
               display:block (it exists to make the leading sentence a title), so a
               <strong> mid-sentence puts every trailer number on its own line and
               strands the punctuation. .idp-mono reads better for an identifier
               anyway. -->
          <div v-if="trailerMismatch" class="idp-warn" role="status">
            <strong>Trailer numbers disagree.</strong>
            Job Tracking says <span class="idp-mono">{{ trailerMismatch.sheet || '—' }}</span>, the rate-con
            says <span class="idp-mono">{{ trailerMismatch.ratecon || '—' }}</span>. Approving will be
            refused until they agree — fix the trailer on the load. Nothing below can override it.
          </div>

          <!-- 2. Bill-To name. Deliberately NOT mirrored from Broker: the two
               legitimately diverge (the Invoice-To block is labelled from the
               recipient's domain), and a silent mirror would overwrite a
               deliberate Bill-To the instant someone fixed a typo in Broker.
               Hence an explicit one-click copy instead. -->
          <div class="idp-field">
            <label class="idp-label" for="idp-billto">
              Invoice to (name)
              <span v-if="edited.billToName" class="idp-badge idp-badge-blue">edited</span>
              <button
                v-if="canCopyBrokerToBillTo"
                type="button"
                class="idp-badge idp-badge-blue"
                :disabled="approving"
                title="Copy the broker name into this field"
                @click="copyBrokerToBillTo"
              >use broker name</button>
            </label>
            <input
              id="idp-billto"
              v-model="form.billToName"
              type="text"
              autocomplete="off"
              maxlength="80"
              class="idp-input"
              :class="{ 'is-edited': edited.billToName }"
              :disabled="approving"
              placeholder="Acme Freight"
              @input="onFieldInput"
            />
            <p v-if="!form.billToName.trim()" class="idp-hint idp-hint-warn">
              Blank — the invoice prints no name above the “Invoice To” address.
            </p>
          </div>

          <!-- 3. Broker name. -->
          <div class="idp-field">
            <label class="idp-label" for="idp-broker">
              Broker name
              <span v-if="edited.brokerName" class="idp-badge idp-badge-blue">edited</span>
            </label>
            <input
              id="idp-broker"
              v-model="form.brokerName"
              type="text"
              autocomplete="off"
              maxlength="80"
              class="idp-input"
              :class="{ 'is-edited': edited.brokerName }"
              :disabled="approving"
              placeholder="C.H. Robinson"
              @input="onFieldInput"
            />
            <!-- Which inbox the draft is addressed to, and which cover letter it
                 uses, both derive from the broker EMAIL, not this string. Editing
                 a display name must never flip the email template. -->
            <p class="idp-hint">
              Printed with the order number as the invoice's reference line. Display name only —
              it does not change which inbox the draft is addressed to.
            </p>
          </div>

          <!-- 4. Total — the highest-risk field on the form. -->
          <div class="idp-field">
            <label class="idp-label" for="idp-total">
              Total
              <span class="idp-badge" :class="totalBadge.cls">{{ totalBadge.text }}</span>
            </label>
            <input
              id="idp-total"
              v-model="form.total"
              type="text"
              inputmode="decimal"
              autocomplete="off"
              class="idp-input"
              :class="{ 'is-invalid': !!(form.total && fieldErrors.total), 'is-edited': edited.total }"
              :aria-invalid="!!fieldErrors.total"
              :disabled="approving"
              placeholder="3000.00"
              @input="onFieldInput"
            />
            <p v-if="fieldErrors.total" class="idp-hint idp-hint-warn">{{ fieldErrors.total }}</p>
            <p v-else-if="pv.needsTotal && !edited.total" class="idp-hint idp-hint-warn">
              No total could be derived from the rate-con or Job Tracking. Type the amount from the
              rate confirmation — this is the one field that has to come from you.
            </p>
            <!-- Owner decision: a corrected total is INVOICE-ONLY. Surfaced here
                 as well as at the confirm, because this is where it's decided. -->
            <p v-else-if="edited.total" class="idp-hint idp-hint-warn">
              Invoice only — Job Tracking's Payment column is <strong>not</strong> changed, so revenue,
              driver pay, investor payouts and the P&amp;L all keep reading the original figure.
            </p>
          </div>

          <!-- 5. Invoice # + invoice date. -->
          <div class="idp-row2">
            <div class="idp-field">
              <label class="idp-label" for="idp-invoiceid">
                Invoice #
                <span v-if="edited.invoiceId" class="idp-badge idp-badge-blue">edited</span>
                <span v-if="invoiceIdDiverges" class="idp-badge idp-badge-amber">not the minted # ⚠</span>
              </label>
              <input
                id="idp-invoiceid"
                v-model="form.invoiceId"
                type="text"
                autocomplete="off"
                maxlength="40"
                class="idp-input idp-mono"
                :class="{ 'is-invalid': !!(form.invoiceId && fieldErrors.invoiceId), 'is-edited': edited.invoiceId }"
                :aria-invalid="!!fieldErrors.invoiceId"
                :disabled="approving"
                @input="onFieldInput"
              />
              <p v-if="fieldErrors.invoiceId" class="idp-hint idp-hint-warn">{{ fieldErrors.invoiceId }}</p>
              <!-- The sequence is consumed on every real approve regardless, so a
                   custom number leaves the minted one burned and unused. -->
              <p v-else-if="invoiceIdDiverges" class="idp-hint idp-hint-warn">
                The next number in sequence is <strong>{{ peekedInvoiceId }}</strong>. It is still
                consumed when you approve, so this invoice will not be in sequence.
              </p>
              <p v-for="w in invoiceIdWarnings" :key="w" class="idp-hint idp-hint-warn">{{ w }}</p>
            </div>
            <div class="idp-field">
              <label class="idp-label" for="idp-invoicedate">
                Invoice date
                <span v-if="edited.invoiceDate" class="idp-badge idp-badge-blue">edited</span>
              </label>
              <!-- Bound to the server's *Iso field and sent back as YYYY-MM-DD.
                   Never reformat a date here: the server's formatDate() loses a
                   day on any ISO input, so a client-side "tidy-up" ships every
                   invoice dated one day early. -->
              <input
                id="idp-invoicedate"
                v-model="form.invoiceDate"
                type="date"
                class="idp-input"
                :class="{ 'is-invalid': !!fieldErrors.invoiceDate, 'is-edited': edited.invoiceDate }"
                :aria-invalid="!!fieldErrors.invoiceDate"
                :disabled="approving"
                @change="onDateCommit"
                @blur="onDateCommit"
              />
              <p v-if="fieldErrors.invoiceDate" class="idp-hint idp-hint-warn">{{ fieldErrors.invoiceDate }}</p>
            </div>
          </div>

          <!-- 6. Order # + PO #. -->
          <div class="idp-row2">
            <div class="idp-field">
              <label class="idp-label" for="idp-order">
                Order #
                <span v-if="edited.orderNumber" class="idp-badge idp-badge-blue">edited</span>
              </label>
              <input
                id="idp-order"
                v-model="form.orderNumber"
                type="text"
                autocomplete="off"
                maxlength="40"
                class="idp-input idp-mono"
                :class="{ 'is-invalid': !!(form.orderNumber && fieldErrors.orderNumber), 'is-edited': edited.orderNumber }"
                :aria-invalid="!!fieldErrors.orderNumber"
                :disabled="approving"
                @input="onFieldInput"
              />
              <p v-if="fieldErrors.orderNumber" class="idp-hint idp-hint-warn">{{ fieldErrors.orderNumber }}</p>
              <p v-else-if="pv.needsOrderNumber && !form.orderNumber.trim()" class="idp-hint idp-hint-warn">
                Required — copy the broker's Order # from the rate confirmation.
              </p>
            </div>
            <div class="idp-field">
              <label class="idp-label" for="idp-po">
                PO #
                <span v-if="edited.poNumber" class="idp-badge idp-badge-blue">edited</span>
              </label>
              <input
                id="idp-po"
                v-model="form.poNumber"
                type="text"
                autocomplete="off"
                maxlength="40"
                class="idp-input idp-mono"
                :class="{ 'is-invalid': !!(form.poNumber && fieldErrors.poNumber), 'is-edited': edited.poNumber }"
                :aria-invalid="!!fieldErrors.poNumber"
                :disabled="approving"
                :placeholder="pv.needsPoNumber ? 'from the rate con' : 'optional'"
                @input="onFieldInput"
              />
              <p v-if="fieldErrors.poNumber" class="idp-hint idp-hint-warn">{{ fieldErrors.poNumber }}</p>
              <!-- `|| noPoOnRatecon` keeps the box mounted after it is ticked. The
                   next preview returns needsPoNumber:false, which unmounted the
                   whole block and left the acknowledgement on with no way to
                   withdraw it short of reopening the modal. -->
              <template v-else-if="pv.needsPoNumber || noPoOnRatecon">
                <p v-if="!form.poNumber.trim() && !noPoOnRatecon" class="idp-hint idp-hint-warn">
                  Required — copy the PO # from the rate confirmation, or tick below if it has none.
                </p>
                <!-- The escape hatch. Some rate-cons carry no PO at all, and
                     without this those loads could never be invoiced again. -->
                <label class="idp-hint idp-check">
                  <input
                    v-model="noPoOnRatecon"
                    type="checkbox"
                    :disabled="approving || !!form.poNumber.trim()"
                  />
                  This rate confirmation has no PO #
                </label>
              </template>
            </div>
          </div>

          <!-- 7. Delivery date — optional, and the template already renders a blank. -->
          <div class="idp-field">
            <label class="idp-label" for="idp-delivery">
              Delivery date
              <span v-if="edited.deliveryDate" class="idp-badge idp-badge-blue">edited</span>
            </label>
            <input
              id="idp-delivery"
              v-model="form.deliveryDate"
              type="date"
              class="idp-input"
              :class="{ 'is-invalid': !!fieldErrors.deliveryDate, 'is-edited': edited.deliveryDate }"
              :aria-invalid="!!fieldErrors.deliveryDate"
              :disabled="approving"
              @change="onDateCommit"
              @blur="onDateCommit"
            />
            <p v-if="fieldErrors.deliveryDate" class="idp-hint idp-hint-warn">{{ fieldErrors.deliveryDate }}</p>
            <p v-else-if="!form.deliveryDate" class="idp-hint">Optional — left blank the invoice prints no delivery date.</p>
          </div>

          <!-- 8. Subject — read-only and taken verbatim from the server response,
               never re-derived here. The point of showing it is that the subject
               you reviewed is provably the subject that gets sent; a client-side
               reconstruction would be a second implementation free to disagree. -->
          <div class="idp-field">
            <label class="idp-label" for="idp-subject">
              Subject
              <span v-if="subjectStale" class="idp-badge idp-badge-amber">updating…</span>
            </label>
            <input
              id="idp-subject"
              class="idp-input"
              type="text"
              readonly
              tabindex="-1"
              :value="previewSubject"
              :title="previewSubject"
            />
            <p class="idp-hint">Built by the server from the fields above — not editable.</p>
          </div>

          <div v-if="previewError" class="idp-warn" role="status">
            <strong>The preview didn't refresh.</strong>
            {{ previewError }} The fields above are still what will be sent — approving re-renders
            everything server-side, so it is safe, but you won't have seen this version.
          </div>

          <div v-if="previewWarnings.length" class="idp-warn" role="status">
            <strong>Check before approving.</strong>
            <span v-for="w in previewWarnings" :key="w" style="display:block;">{{ w }}</span>
          </div>

          <div class="idp-reset-row">
            <button
              type="button"
              class="idp-btn idp-btn-ghost"
              :disabled="approving || !anyEdited"
              title="Put every field back to the value the server extracted"
              @click="resetToExtracted"
            >Reset to extracted values</button>
          </div>

          <div v-if="approveError" class="idp-error" role="alert">{{ approveError }}</div>
        </div>
      </div>

      <div class="idp-footer">
        <!-- The note doubles as the disabled-button explanation. A primary action
             that is greyed out with no stated reason reads as a broken app, and
             "you have edits nobody has rendered yet" is not guessable. -->
        <span class="idp-foot-note" :class="{ 'idp-hint-warn': !!approveBlockedReason }">
          {{ approveBlockedReason || 'Saves a Gmail draft — it is never auto-sent.' }}
        </span>
        <div class="idp-foot-actions">
          <button type="button" class="idp-btn idp-btn-ghost" :disabled="approving" @click="onOpenChange(false)">Cancel</button>
          <button
            type="button"
            class="idp-btn idp-btn-primary"
            :disabled="approving || !canApprove"
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
import { computed, reactive, ref, watch, onBeforeUnmount } from 'vue'
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
// The preview route does no Sheets / Gemini / Drive work — only buildInvoiceHtml
// + renderHtmlToPdf — but Puppeteer runs `waitUntil: networkidle0` against a
// template that still links a remote Google Font, so a blocked-egress render
// waits out its own 30s timeout. 45s leaves room for that without letting a
// wedged render hold the "approve is disabled" state open indefinitely.
const PREVIEW_TIMEOUT_MS = 45000
// Long enough that typing "3,000.00" is one render, not six.
const PREVIEW_DEBOUNCE_MS = 600

const pv = computed(() => props.preview || {})

// --- Validation ---------------------------------------------------------------
// These mirror the server's parseInvoiceOverrides rules. They are a courtesy, not
// the guard — the server re-validates everything — but they are what stops a
// doomed body costing a Chromium render, and what lets a field say WHY it's wrong.
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,39}$/
const REF_RE = /^[A-Za-z0-9][A-Za-z0-9 ._/#-]{0,39}$/
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/
// A FORMAT gate, deliberately ahead of any parse: the server's parseMoney is a
// mangler rather than a validator (it strips everything outside [0-9.-], so
// "12abc34" becomes 1234 and sails through a `> 0` check). Same shape here so the
// client and the server agree about what a money string is.
const MONEY_RE = /^\$?\s*(\d{1,3}(,\d{3})*|\d+)(\.\d{1,2})?$/
// 0.01, not "> 0": formatMoney(0.001) prints "$0.00" — a positive number that
// renders as zero, which would walk straight past the never-draft-a-$0.00 rule.
const TOTAL_MIN = 0.01
const TOTAL_MAX = 1000000

const str = (v) => (v == null ? '' : String(v))
// An <input type="date"> silently discards anything that isn't YYYY-MM-DD, so a
// malformed server date would display blank while the model still held it — and
// then get sent. Normalise to "" instead, which is a value the server accepts and
// the template renders as absent, rather than shipping an unparseable string that
// buildInvoiceHtml would print verbatim onto the broker's invoice.
const isoDate = (v) => (ISO_DATE_RE.test(str(v)) ? str(v) : '')
function moneyValue(s) {
  const t = str(s).replace(/[$,\s]/g, '')
  if (!t) return null
  const n = Number(t)
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : NaN
}
function fmtMoney(n) {
  return Number.isFinite(n) ? n.toLocaleString('en-US', { style: 'currency', currency: 'USD' }) : ''
}

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

// --- The editable invoice fields --------------------------------------------
// One reactive object for the eight overridable fields, plus a frozen snapshot of
// what the server extracted. The snapshot is what "edited" and "Reset" compare
// against — not props.preview, which must stay the untouched server response.
const EMPTY_FORM = () => ({
  billToName: '', brokerName: '', total: '',
  invoiceId: '', invoiceDate: '', orderNumber: '', poNumber: '', deliveryDate: '',
})
const form = reactive(EMPTY_FORM())
const seeded = ref(EMPTY_FORM())
// The number the server would mint next. Captured at open and NOT refreshed from
// each preview response: re-reading it per render would make the amber "not the
// minted #" badge blink on and off as other dispatchers approve their own drafts.
const peekedInvoiceId = ref('')
// Bison-ness as the dryRun derived it FROM THE SHEET's broker email. Pinned, never
// re-derived here, and preview-only — see the note in buildOverrideBody().
const pinnedIsBison = ref(null)
// Raw Number, kept for the edited-total confirm. The formatted `pv.total` string
// is display only — reparsing our own formatting is how a factor-of-1000 error
// reaches an invoice.
const seededTotalAmount = computed(() => {
  const n = Number(pv.value.totalAmount)
  return Number.isFinite(n) ? n : null
})

function seedForm() {
  const p = pv.value
  const t = Number(p.totalAmount)
  const next = {
    billToName: str(p.billToName),
    brokerName: str(p.brokerName),
    // From the RAW totalAmount, never the formatted `pv.total`.
    total: Number.isFinite(t) && t > 0 ? t.toFixed(2) : '',
    invoiceId: str(p.invoiceId || p.peekedInvoiceId),
    // The *Iso fields exist so <input type="date"> binds directly: no client
    // reparsing, and therefore no way to reintroduce the ISO off-by-one day.
    invoiceDate: isoDate(p.invoiceDateIso),
    orderNumber: str(p.orderNumber),
    poNumber: str(p.poNumber),
    deliveryDate: isoDate(p.deliveryDateIso),
  }
  Object.assign(form, next)
  seeded.value = { ...next }
  recipient.value = originalTo.value
  peekedInvoiceId.value = str(p.peekedInvoiceId)
  // Strict boolean only. Anything else stays null so the field is omitted and the
  // server falls back to deriving it — see buildOverrideBody().
  pinnedIsBison.value = typeof p.isBison === 'boolean' ? p.isBison : null
}

const edited = computed(() => {
  const s = seeded.value
  return {
    billToName: form.billToName.trim() !== str(s.billToName).trim(),
    brokerName: form.brokerName.trim() !== str(s.brokerName).trim(),
    // Compared by VALUE, so "3000.00" and "3,000.00" are not an edit.
    total: moneyValue(form.total) !== moneyValue(s.total),
    invoiceId: form.invoiceId.trim() !== str(s.invoiceId).trim(),
    invoiceDate: form.invoiceDate !== str(s.invoiceDate),
    orderNumber: form.orderNumber.trim() !== str(s.orderNumber).trim(),
    poNumber: form.poNumber.trim() !== str(s.poNumber).trim(),
    deliveryDate: form.deliveryDate !== str(s.deliveryDate),
  }
})
const anyEdited = computed(() => isEdited.value || Object.values(edited.value).some(Boolean))

const fieldErrors = computed(() => {
  const e = {}
  if (!recipient.value.trim()) e.recipient = 'A recipient is required before approving.'
  else if (!recipientValid.value) e.recipient = "That doesn't look like a valid email."

  const id = form.invoiceId.trim()
  if (!id) e.invoiceId = 'An invoice number is required.'
  else if (!ID_RE.test(id)) e.invoiceId = 'Letters, numbers and . _ / - only, 40 characters max.'

  if (!ISO_DATE_RE.test(form.invoiceDate)) e.invoiceDate = 'Pick an invoice date.'

  const ord = form.orderNumber.trim()
  // Not merely required for the printed line: it also names the invoice
  // attachment, so an empty one produces a file literally called ".pdf".
  if (!ord) e.orderNumber = 'An order number is required — it names the invoice attachment.'
  else if (!REF_RE.test(ord)) e.orderNumber = 'Letters, numbers, spaces and . _ / # - only, 40 max.'

  const po = form.poNumber.trim()
  if (po && !REF_RE.test(po)) e.poNumber = 'Letters, numbers, spaces and . _ / # - only, 40 max.'

  if (form.deliveryDate && !ISO_DATE_RE.test(form.deliveryDate)) {
    e.deliveryDate = 'Enter a valid delivery date, or clear it.'
  }

  const t = form.total.trim()
  if (!t) e.total = 'An amount is required — an invoice is never drafted at $0.00.'
  else if (!MONEY_RE.test(t)) e.total = 'Enter a plain amount, e.g. 3000.00 or 3,000.00.'
  else {
    const n = moneyValue(t)
    if (!(n >= TOTAL_MIN && n <= TOTAL_MAX)) e.total = 'Must be between $0.01 and $1,000,000.00.'
  }
  return e
})
const formValid = computed(() => Object.keys(fieldErrors.value).length === 0)
// Reported in the order the fields appear, so "the first thing wrong" is the
// first thing you'd reach scrolling down.
const FIELD_ORDER = ['recipient', 'billToName', 'brokerName', 'total', 'invoiceId', 'invoiceDate', 'orderNumber', 'poNumber', 'deliveryDate']
const firstFieldError = computed(() => {
  for (const k of FIELD_ORDER) if (fieldErrors.value[k]) return fieldErrors.value[k]
  return ''
})

const TOTAL_SOURCE_LABEL = {
  ratecon: 'from the rate-con',
  sheet: "from Job Tracking's Payment column",
  manual: 'entered manually',
}
const totalBadge = computed(() => {
  if (edited.value.total) return { text: 'manual', cls: 'idp-badge-blue' }
  const src = pv.value.totalSource
  if (src === 'ratecon') return { text: 'from rate-con ✓', cls: 'idp-badge-green' }
  if (src === 'sheet') return { text: 'from Job Tracking', cls: 'idp-badge-blue' }
  return { text: 'not found — enter the amount ⚠', cls: 'idp-badge-amber' }
})

const invoiceIdDiverges = computed(
  () => !!peekedInvoiceId.value && form.invoiceId.trim() !== peekedInvoiceId.value,
)
// The invoice-number collision comes back in the free-text warnings[] array, and
// it is the one warning that belongs beside a specific field. Matched loosely on
// purpose — and every warning is ALSO rendered in the block below, so one this
// pattern doesn't recognise is surfaced rather than swallowed.
const INVOICE_COLLISION_RE = /invoice/i
const INVOICE_COLLISION_HINT_RE = /already|exist|duplicat|collision|in use|reuse|taken/i
const invoiceIdWarnings = computed(() =>
  previewWarnings.value.filter(
    (w) => INVOICE_COLLISION_RE.test(str(w)) && INVOICE_COLLISION_HINT_RE.test(str(w)),
  ),
)

// Trailer is echoed by the dryRun so the mismatch can be shown BEFORE eight
// fields are edited — the 409 fires on approve, and Gemini being nondeterministic
// means a clean preview is no guarantee.
const trailerMismatch = computed(() => {
  const tc = pv.value.trailerCheck
  return tc && tc.ok === false ? tc : null
})

const canCopyBrokerToBillTo = computed(
  () => !!form.brokerName.trim() && form.brokerName.trim() !== form.billToName.trim(),
)
function copyBrokerToBillTo() {
  form.billToName = form.brokerName.trim()
  schedulePreview()
}

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
// Falls back to the dryRun's copy so the tab can never disappear mid-session
// (a preview that returned no emailHtml would otherwise remove a tab under the
// cursor); previewEmailHtml wins as soon as one render has landed.
const hasEmail = computed(() => !!(previewEmailHtml.value || pv.value.emailHtml))
// The exact Gmail draft body. Trusted server HTML — buildInvoiceEmailHtml esc()'s
// every dynamic field — so it's rendered via v-html. It MUST come from the latest
// preview: it is built from the invoice fields, so once those are editable a
// dryRun-only copy silently shows a cover note that will not be the one sent.
const emailHtml = computed(() => previewEmailHtml.value || pv.value.emailHtml || '')
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
let invoiceBlobUrl = null   // the URL currently bound to the viewer
let invoiceBlobPrev = null  // the one before it, kept alive exactly one generation
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

// Swap in a freshly rendered invoice. Two hazards, and they pull in opposite
// directions: assigning a new URL without revoking the old one leaks ~50-200 KB
// per render, but revoking SYNCHRONOUSLY can kill a fetch that is still running —
// PdfZoomViewer watches props.src and re-fetches, so a revoked URL lands it on
// .pz-status-fail, whose "Open PDF" link then points at the dead URL too. So hold
// ONE generation: revoke the older one, demote current -> prev, install next.
// Bounded at 2 live object URLs however many renders happen.
//
// This deliberately does NOT go through buildBlobs(), which revokes the rate-con
// blobs as well and would re-decode every rate-con PDF on every keystroke.
function setInvoicePdf(b64) {
  const next = b64ToBlobUrl(b64)
  if (invoiceBlobPrev) URL.revokeObjectURL(invoiceBlobPrev)
  invoiceBlobPrev = invoiceBlobUrl
  invoiceBlobUrl = next
  invoiceUrl.value = next || ''
}

function revokeBlobs() {
  // Cancel first. A response landing after this point would mint a fresh object
  // URL into a world where nothing is left to revoke it, and re-point the viewer
  // at a document the dispatcher has already closed.
  cancelPreview()
  if (invoiceBlobUrl) { URL.revokeObjectURL(invoiceBlobUrl); invoiceBlobUrl = null }
  if (invoiceBlobPrev) { URL.revokeObjectURL(invoiceBlobPrev); invoiceBlobPrev = null }
  rateconBlobUrls.forEach((u) => { if (u) URL.revokeObjectURL(u) })
  rateconBlobUrls = []
  invoiceUrl.value = ''
  rateconUrls.value = []
}

function buildBlobs() {
  revokeBlobs()
  setInvoicePdf(pv.value.invoicePdfBase64)
  rateconBlobUrls = ratecons.value.map((rc) => b64ToBlobUrl(rc.base64))
  rateconUrls.value = rateconBlobUrls.slice()
}

// --- Live preview render ------------------------------------------------------
// POST /api/loads/:loadId/invoice-preview re-renders the PDF, subject and cover
// note from whatever is currently in the form. It touches no Sheets, no Gemini,
// no Drive and writes nothing — which is why it can be fired on a debounce at all.
const previewing = ref(false)     // a render is in flight
const previewPending = ref(false) // edits exist that no render has covered yet
const previewError = ref('')
const previewWarnings = ref([])
const previewSubject = ref('')
const previewEmailHtml = ref('')
let previewSeq = 0
let previewTimer = null
let previewAbort = null

// Tabs whose content IS the preview output. Auto-rendering only while one of them
// is on screen keeps a Chromium render off the POD / rate-con tabs, where nobody
// would see it — and it is the mitigation for PdfZoomViewer's src watcher calling
// reset(): the zoom and pan you set are only thrown away on the tab where you can
// actually see what changed. A render deferred this way stays `previewPending`,
// which blocks approve and says so, and is flushed by the watcher below.
const PREVIEW_TABS = new Set(['invoice', 'email'])
const previewTabActive = computed(() => PREVIEW_TABS.has(activeTab.value))
const subjectStale = computed(() => previewing.value || previewPending.value)

function cancelPreview() {
  if (previewTimer) { clearTimeout(previewTimer); previewTimer = null }
  previewPending.value = false
  // Bump the sequence as well as aborting: an abort races, and a response already
  // decoded on the wire must still be recognised as superseded.
  previewSeq++
  if (previewAbort) { previewAbort.abort(); previewAbort = null }
  previewing.value = false
}

function schedulePreview({ immediate = false } = {}) {
  if (previewTimer) { clearTimeout(previewTimer); previewTimer = null }
  if (!props.open) return
  // Never spend a render on a body the server will refuse.
  if (!formValid.value) { previewPending.value = false; return }
  previewPending.value = true
  if (immediate) { runPreview(); return }
  previewTimer = setTimeout(runPreview, PREVIEW_DEBOUNCE_MS)
}

async function runPreview() {
  if (previewTimer) { clearTimeout(previewTimer); previewTimer = null }
  if (!props.open || !formValid.value) { previewPending.value = false; return }
  if (!previewTabActive.value) return // stays pending; flushed on tab activation
  previewPending.value = false

  // BOTH stale guards, deliberately. previewSeq drops a slow response a newer
  // request has already superseded; the AbortController additionally cancels the
  // older render server-side, where INVOICE_PREVIEW_MAX_INFLIGHT is 2 — leaving
  // two abandoned Chromium pages running would starve the render being waited on.
  if (previewAbort) previewAbort.abort()
  const ctrl = new AbortController()
  previewAbort = ctrl
  const seq = ++previewSeq
  previewing.value = true
  try {
    const r = await api.post(
      `/api/loads/${encodeURIComponent(props.loadId)}/invoice-preview`,
      buildOverrideBody({ forPreview: true }),
      { timeout: PREVIEW_TIMEOUT_MS, signal: ctrl.signal },
    )
    if (seq !== previewSeq) return
    previewError.value = ''
    previewSubject.value = str(r.subject)
    previewEmailHtml.value = str(r.emailHtml)
    previewWarnings.value = Array.isArray(r.warnings) ? r.warnings.filter(Boolean).map(str) : []
    // Adopt the peeked number only if we never had one (an older cached dryRun).
    // Refreshing it per render would make the divergence badge flicker.
    if (!peekedInvoiceId.value && r.peekedInvoiceId) peekedInvoiceId.value = str(r.peekedInvoiceId)
    setInvoicePdf(r.invoicePdfBase64)
  } catch (e) {
    if (seq !== previewSeq) return
    // useApi maps a caller abort to code 'ABORT', distinct from its own 'TIMEOUT'.
    // We aborted this one on purpose; a newer render is already running.
    if (e && e.code === 'ABORT') return
    previewError.value = (e && e.message) || 'Could not render the preview.'
  } finally {
    // Only the newest request owns the flag — an older one settling later must
    // not clear the spinner for the render still running.
    if (previewAbort === ctrl) { previewAbort = null; previewing.value = false }
  }
}

function onFieldInput() { schedulePreview() }
// Dates commit in one gesture rather than character by character, so debouncing
// them just adds lag; `blur` covers a keyboard-typed date that never fires change.
function onDateCommit() { schedulePreview({ immediate: true }) }

function resetToExtracted() {
  seedForm()
  previewError.value = ''
  schedulePreview({ immediate: true })
}

// Flush a render that was held back while a non-preview tab was showing.
watch(previewTabActive, (active) => { if (active && previewPending.value) runPreview() })

// --- Request body -------------------------------------------------------------
// ONE builder for both the preview and the approve, mirroring the server's single
// parseInvoiceOverrides: two copies of "what gets sent" is how the thing you
// previewed stops being the thing you sent.
//
// Omitted vs empty is a real distinction on the server — an absent key means
// "derive it", "" means "the dispatcher cleared it". If the dryRun never carried
// a key, this modal has nothing to show for it, so its blank input is OUR
// ignorance and not the dispatcher's decision: omit it and let the server derive,
// unless the dispatcher actually typed something.
function has(key) { return Object.prototype.hasOwnProperty.call(pv.value, key) }
function buildOverrideBody({ forPreview = false } = {}) {
  const body = {
    // Always sent: each is required, validated above, and visible on the form.
    invoiceId: form.invoiceId.trim(),
    invoiceDate: form.invoiceDate,        // YYYY-MM-DD, exactly as the input emits it
    orderNumber: form.orderNumber.trim(),
    total: form.total.trim(),             // raw; the server owns money parsing
    // Pinned for the same reason it always was: approve re-runs the whole
    // extraction, so sending the reviewed address is what stops a nondeterministic
    // re-resolve redirecting the draft somewhere the dispatcher never saw.
    recipientEmail: recipient.value.trim(),
  }
  if (has('billToName') || edited.value.billToName) body.billToName = form.billToName.trim()
  if (has('brokerName') || edited.value.brokerName) body.brokerName = form.brokerName.trim()
  // ⚠️ NO `has('poNumber')` ARM. The dryRun echoes poNumber, so has() is ALWAYS
  // true — which sent the key on every request and made the server's
  // omitted-vs-empty rule meaningless: `ov.has.poNumber` was permanently set, so
  // needsPoNumber could never fire and the `|| noPoOnRatecon` clause below was
  // dead code contradicting its own comment. Send it only when a human has
  // actually answered: typed a value, or ticked "this rate-con has no PO #".
  if (edited.value.poNumber || noPoOnRatecon.value) body.poNumber = form.poNumber.trim()
  if (has('deliveryDateIso') || edited.value.deliveryDate) body.deliveryDate = form.deliveryDate
  // A 9th, non-UI pinned field: moveNumber has no input but IS printed in the
  // Bison cover letter, so passing it through is what keeps the emailed body the
  // one that was reviewed. Same reasoning as the recipient.
  if (has('moveNumber')) body.moveNumber = str(pv.value.moveNumber)

  // ⚠️ PREVIEW ONLY — and the asymmetry between the two bodies is the point, not
  // an oversight, so it is the one thing this shared builder branches on.
  //
  // APPROVE derives isBison from the SHEET's broker email. That choice selects the
  // AP inbox, i.e. it decides where money gets invoiced, so it must not be
  // answerable by the client; the server refuses to read it from the body there,
  // and sending it anyway would imply otherwise to the next reader.
  //
  // PREVIEW reads no sheet at all. Left to itself it would infer Bison-ness from
  // the RECIPIENT — which this modal just made editable. Re-route a Bison load to
  // another address and you would preview the generic cover letter but send the
  // Bison one (and the reverse), which is exactly the "what I reviewed is not what
  // was sent" failure the Email tab exists to prevent. So pin the value the dryRun
  // already derived from the sheet.
  //
  // Strict boolean: the server ignores anything that is not true/false and falls
  // back to deriving, so a "false" STRING would silently flip it back on.
  if (forPreview && typeof pinnedIsBison.value === 'boolean') body.isBison = pinnedIsBison.value
  return body
}

// Approve state — declared BEFORE the immediate watch below (which reads
// approveError) so its `immediate` run during setup doesn't hit a temporal-
// dead-zone ("Cannot access 'approveError' before initialization").
const approving = ref(false)
const approveError = ref('')

// The Order # could not be read off the rate-con, so the server would fall back
// to OUR load id — a number Bison AP cannot match a payment to. It refuses the
// approve with 422 INVOICE_REFS_REQUIRED; this mirrors that refusal so the block
// shows up beside the fields instead of arriving as an error after the click.
//
// A typed value satisfies it. An explicitly EMPTIED PO # also satisfies it —
// clearing a field is a decision, leaving it untouched is not. That is the same
// omitted-vs-empty rule the server's override parser applies, so the two agree.
const noPoOnRatecon = ref(false)
const refsBlocked = computed(() => {
  const p = pv.value
  if (p.needsOrderNumber && !String(form.orderNumber || '').trim()) return true
  // ⚠️ THE CHECKBOX IS NOT CEREMONY — without it this is a dead end. Some
  // rate-cons genuinely carry no PO, and "you may proceed once you type a PO"
  // would leave those loads permanently un-invoiceable. Ticking it sends an
  // explicit empty poNumber, which is what the server's omitted-vs-empty rule
  // accepts: a human said "there isn't one", rather than nobody having looked.
  if (p.needsPoNumber && !String(form.poNumber || '').trim() && !noPoOnRatecon.value) return true
  return false
})
// ⚠️ STOPS BEING TRUE THE MOMENT IT IS FIXED. `pv` is the ORIGINAL dryRun
// response and never changes while the modal is open, so keying the banner on it
// alone would keep insisting the field shows our load number after the
// dispatcher has replaced it with the broker's — telling them a falsehood about
// what they are looking at, which is how a warning stops being believed.
const rateconInferred = computed(() => pv.value.rateconSource === 'drive-content')
const orderNumberIsFallback = computed(
  () => pv.value.orderNumberSource === 'load-id-fallback' && !edited.value.orderNumber,
)

// Never approve a value nobody has seen rendered. A FAILED preview is deliberately
// not a block, though: a render outage would otherwise make the whole feature
// unusable, and the failure is surfaced loudly beside the fields instead.
const canApprove = computed(() => formValid.value && !previewing.value && !previewPending.value && !refsBlocked.value)
const approveBlockedReason = computed(() => {
  if (approving.value || canApprove.value) return ''
  if (firstFieldError.value) return firstFieldError.value
  if (refsBlocked.value) {
    return 'Enter the Order # and PO # from the rate confirmation — they could not be read automatically.'
  }
  if (previewing.value) return 'Rendering your changes — approve once the preview updates.'
  if (previewPending.value) {
    return previewTabActive.value
      ? 'Rendering your changes — approve once the preview updates.'
      : 'Open the Invoice tab to render your edits — the draft is only built from values you have seen.'
  }
  return ''
})

// Seed on the CLOSED -> OPEN transition only. The old watcher also fired on any
// new `props.preview` identity: nothing re-fetches while the modal is open today,
// but the moment something does, that shape silently wipes the dispatcher's edits.
watch(
  () => props.open,
  (isOpen, wasOpen) => {
    if (isOpen && !wasOpen && props.preview) {
      buildBlobs()
      seedForm()
      activeTab.value = 'invoice'
      approveError.value = ''
      previewError.value = ''
      previewWarnings.value = []
      // Per-load acknowledgement — it must never carry from one load to the next,
      // or the second load inherits "there is no PO" without anyone saying so.
      noPoOnRatecon.value = false
      // The dryRun response IS a render of the extracted values, so its subject
      // and cover note are correct until the first edit — seed from them rather
      // than blanking and firing a render nobody asked for.
      previewSubject.value = str(pv.value.subject)
      previewEmailHtml.value = str(pv.value.emailHtml)
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

// Owner decision #2, surfaced at the moment of commitment: a corrected total is
// INVOICE-ONLY. It names the divergence and states that the sheet does not move —
// and it deliberately never quotes a figure this component was not given. When no
// total could be derived there IS no original, so saying "the sheet says $X" would
// be an invention on the one screen where a number is read as fact.
function totalChangeConfirm() {
  const billed = fmtMoney(moneyValue(form.total))
  const orig = seededTotalAmount.value != null && seededTotalAmount.value > 0
    ? fmtMoney(seededTotalAmount.value)
    : ''
  if (!orig) {
    return `This invoice will bill ${billed}.\n\n`
      + 'No total could be derived for this load, so that figure comes from you. '
      + "Job Tracking's Payment column will NOT be changed by it — revenue, driver pay, "
      + 'investor payouts and the P&L all keep reading the sheet.\n\nContinue?'
  }
  const src = TOTAL_SOURCE_LABEL[pv.value.totalSource]
  return `This invoice will bill ${billed}.\n\n`
    + `The figure on this load${src ? ` (${src})` : ''} is ${orig}, and it will NOT be changed. `
    + "Job Tracking's Payment column, revenue, driver pay, investor payouts and the P&L "
    + `all keep reading ${orig}.\n\nContinue?`
}

async function approve() {
  if (approving.value || !canApprove.value) return
  // Re-approving an already-drafted load mints a SECOND draft + invoice number
  // (the first is not removed), so require an explicit confirm first.
  if (props.alreadyDrafted && !window.confirm(DUPLICATE_APPROVE_MSG)) return
  // Second confirm, and only for the total: it is the one edit that makes the
  // invoice disagree with the books on purpose.
  if (edited.value.total && !window.confirm(totalChangeConfirm())) return
  approving.value = true
  approveError.value = ''
  try {
    // The SAME body the preview rendered — one builder, so what was reviewed is
    // what is sent. The recipient is pinned for the reason it always was: approve
    // re-runs the whole extraction pipeline (fresh Gemini), so sending the exact
    // address the dispatcher reviewed stops a nondeterministic re-resolve
    // redirecting the draft. The backend still classifies it "manual" only when it
    // differs from its own re-resolved value, so an unchanged send preserves the
    // ratecon/default source badge.
    const body = buildOverrideBody()
    const r = await api.post(
      `/api/loads/${encodeURIComponent(props.loadId)}/draft-invoice`,
      body,
      { timeout: APPROVE_TIMEOUT_MS },
    )
    emit('approved', { invoiceId: r.invoiceId, recipient: recipient.value.trim() || originalTo.value })
    emit('update:open', false)
  } catch (e) {
    // Always true and worth saying: the modal stays open and every field keeps its
    // value, so a trailer 409 or a validation refusal is a correction, not a redo.
    const msg = (e && e.message) || 'Failed to create the draft.'
    approveError.value = `${msg} Nothing was sent — your edits are still here.`
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
/* [readonly] shares the disabled treatment: the Subject field is server-owned, and
   it should read as "not yours to change" exactly like a disabled input does. */
.idp-input:disabled,
.idp-input[readonly] { background: #f9fafb; color: #6b7085; }
/* ORDER IS LOAD-BEARING: .is-edited and .is-invalid have equal specificity, so the
   later rule wins. Invalid must outrank edited — a field that is both is a field
   you have to fix. */
.idp-input.is-edited { border-color: #93c5fd; background: #f8fbff; }
.idp-input.is-invalid { border-color: #dc2626; background: #fffafa; }
.idp-hint { font-size: 0.72rem; color: #64748b; margin: 0; }
.idp-hint-warn { color: #b45309; }
/* The "no PO #" acknowledgement. Sits with the hints because that is what it
   is — a line of guidance the dispatcher answers, not a settings toggle. */
.idp-check { display: flex; align-items: center; gap: 0.4rem; margin-top: 0.25rem; cursor: pointer; }
.idp-check input { cursor: pointer; }
.idp-check input:disabled { cursor: default; }

/* Two-up pairs — [Invoice # | Invoice date] and [Order # | PO #]. They are read
   together, so they sit together. min-width:0 stops a date input's intrinsic
   minimum width from overflowing the 380px column. */
.idp-row2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.75rem;
}
.idp-row2 > * { min-width: 0; }

.idp-reset-row { display: flex; justify-content: flex-end; }

/* A badge that is also a control ("use broker name"). Element-qualified, so every
   plain <span> badge is untouched. */
button.idp-badge { font-family: inherit; cursor: pointer; }
button.idp-badge:hover:not(:disabled) { filter: brightness(0.96); }
button.idp-badge:disabled { opacity: 0.6; cursor: not-allowed; }

.idp-mono { font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 0.82rem; }

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
  /* Two inputs side by side stop being readable well before this; a date input in
     particular has a large intrinsic minimum. */
  .idp-row2 { grid-template-columns: 1fr; }
  .idp-foot-actions { width: 100%; }
  .idp-foot-actions .idp-btn { flex: 1; justify-content: center; }
}
</style>
