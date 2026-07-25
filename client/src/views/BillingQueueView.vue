<template>
  <div class="flex flex-col">
    <div class="dash-header">
      <div>
        <h2 class="text-[1.4rem] font-bold text-gray-900 tracking-tight">Ready for Billing</h2>
        <p class="text-[13px] text-gray-400 mt-0.5">
          Loads whose signed BOL staged a Quick-Pay invoice draft in Gmail, waiting for a dispatcher
          to review and send. Nothing is emailed automatically &mdash; you send from Gmail.
        </p>
      </div>
      <div class="flex items-center gap-3">
        <span class="text-[11px] text-gray-400 font-mono bg-gray-50 px-3 py-1.5 rounded-full border border-gray-100">
          {{ store.loads.length }} queued<template v-if="store.pendingCount"> &middot; {{ store.pendingCount }} pending</template>
        </span>
        <Button variant="outline" class="rounded-md border-[#e2e4ea] text-[12px] h-9" :disabled="store.isLoading" @click="refresh">&#8635; Refresh</Button>
      </div>
    </div>

    <Card class="flex flex-col" style="border-radius:14px;border:1px solid #e8edf2;box-shadow:0 1px 4px rgba(0,0,0,0.06), 0 4px 12px rgba(0,0,0,0.04);">
      <CardContent style="padding:0;">
        <!-- Loading (first load only — a refresh keeps the current list in place) -->
        <div v-if="store.isLoading && !store.loads.length" class="flex items-center justify-center py-16">
          <div class="text-[13px] text-gray-400">Loading the billing queue&hellip;</div>
        </div>

        <!-- Graceful fallback: the queue endpoint is built in parallel, so a 404
             reads as "not available yet" rather than a hard error. -->
        <template v-else-if="loadFailed">
          <div v-if="notFound" class="flex flex-col items-center justify-center py-16 gap-2 text-center px-6">
            <div class="text-[2rem]">&#129534;</div>
            <div class="text-[14px] text-gray-500 font-medium">The billing queue isn&rsquo;t available yet</div>
            <div class="text-[12px] text-gray-400 max-w-[340px] leading-relaxed">
              Loads land here once a driver uploads a signed BOL and the Post-Trip Draft Engine is live.
            </div>
          </div>
          <div v-else class="flex flex-col items-center justify-center py-16 gap-3 text-center px-6">
            <div class="text-[14px] text-red-600 font-medium">Couldn&rsquo;t load the billing queue</div>
            <div class="text-[12px] text-gray-400 max-w-[340px]">{{ errorMsg || 'Something went wrong — try again.' }}</div>
            <Button variant="outline" size="sm" @click="refresh">Retry</Button>
          </div>
        </template>

        <!-- Empty -->
        <EmptyState v-else-if="!store.loads.length">No loads waiting to be billed.</EmptyState>

        <!-- Data -->
        <template v-else>
          <!-- Mobile: a card per queued load -->
          <div v-if="isMobile" class="flex flex-col gap-2.5 p-2.5">
            <div v-for="row in store.loads" :key="row.loadId" class="rounded-[10px] border border-gray-200 bg-white p-3.5 flex flex-col gap-2.5">
              <div class="flex items-center justify-between gap-2">
                <span class="font-mono font-bold text-[0.92rem] text-slate-900">{{ row.loadId }}</span>
                <span class="inline-flex items-center rounded-full border px-2 py-0.5 text-[0.62rem] font-bold uppercase tracking-wide" :class="statusMeta(row.status).cls">{{ statusMeta(row.status).label }}</span>
              </div>
              <div class="flex flex-col gap-1 pt-2 border-t border-gray-100 text-[0.82rem]">
                <div class="flex gap-2"><span class="w-[58px] shrink-0 text-[0.66rem] font-semibold uppercase tracking-wide text-slate-400 pt-0.5">Broker</span><span class="text-slate-700">{{ row.broker || '—' }}</span></div>
                <div class="flex gap-2"><span class="w-[58px] shrink-0 text-[0.66rem] font-semibold uppercase tracking-wide text-slate-400 pt-0.5">Route</span><span class="text-slate-700">{{ row.route || '—' }}</span></div>
              </div>
              <div class="flex flex-wrap gap-1.5 pt-2 border-t border-gray-100">
                <span
                  v-for="c in checklistOf(row)"
                  :key="c.key"
                  class="inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-semibold"
                  :class="c.ok ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-gray-50 text-gray-400 border-gray-200'"
                  :title="c.label + (c.ok ? ' — attached' : ' — missing')"
                >
                  <span aria-hidden="true">{{ c.ok ? '✓' : '✗' }}</span>{{ c.label }}
                </span>
              </div>
              <div class="pt-2 border-t border-gray-100">
                <!-- Action + context (mirrors the desktop table's Action cell) -->
                <div class="flex flex-col items-start gap-1.5">
                  <a
                    v-if="row.status === 'drafted'"
                    :href="GMAIL_DRAFTS_URL"
                    target="_blank"
                    rel="noopener noreferrer"
                    class="inline-flex items-center gap-1.5 rounded-md bg-[#0f2847] hover:bg-[#1a3a5c] text-white text-[12px] font-semibold px-3 py-1.5 transition-colors whitespace-nowrap"
                    title="Open the Gmail Drafts folder — find the draft by its subject, review it, then send"
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 6L2 7"/></svg>
                    Review Draft
                  </a>
                  <Button
                    v-else
                    size="sm"
                    :disabled="generatingId === row.loadId"
                    @click="generateDraft(row)"
                  >{{ generatingId === row.loadId ? 'Generating…' : 'Generate Draft' }}</Button>

                  <!-- Drafted: the draft is found in Gmail by subject, so surface + copy it -->
                  <div v-if="row.status === 'drafted' && row.draftSubject" class="flex items-center gap-1.5 max-w-full">
                    <span class="font-mono text-[11px] text-gray-500 truncate" :title="row.draftSubject">{{ row.draftSubject }}</span>
                    <button type="button" class="inline-flex items-center gap-1 rounded border border-gray-200 bg-white px-1.5 h-[22px] text-[11px] hover:bg-gray-50 transition-colors shrink-0" :class="copiedId === row.loadId ? 'text-emerald-600 border-emerald-200' : 'text-gray-500'" :title="copiedId === row.loadId ? 'Copied!' : 'Copy draft subject'" @click="copySubject(row)">{{ copiedId === row.loadId ? '✓ Copied' : '⧉ Copy' }}</button>
                  </div>
                  <div v-if="row.status === 'drafted' && (row.invoiceNumber || draftedWhen(row))" class="text-[11px] text-gray-400">
                    <span v-if="row.invoiceNumber" class="font-mono">#{{ row.invoiceNumber }}</span><span v-if="row.invoiceNumber && draftedWhen(row)"> · </span><span v-if="draftedWhen(row)">drafted {{ draftedWhen(row) }}</span>
                  </div>
                  <!-- Pending: explain why it isn't drafted yet -->
                  <div v-if="row.status === 'pending' && row.lastError" class="text-[11px] text-red-600 leading-snug" :title="row.lastError">{{ row.lastError }}</div>
                  <div v-else-if="row.status === 'pending'" class="text-[11px] text-gray-400">Not drafted yet — generate when the rate-con is in.</div>
                </div>
              </div>
            </div>
          </div>

          <!-- Desktop: table -->
          <Table v-else>
            <TableHeader>
              <TableRow class="bg-gray-50/80 hover:bg-gray-50/80">
                <TableHead class="text-[11px] font-bold text-gray-500 uppercase tracking-wider">Load ID</TableHead>
                <TableHead class="text-[11px] font-bold text-gray-500 uppercase tracking-wider">Broker</TableHead>
                <TableHead class="text-[11px] font-bold text-gray-500 uppercase tracking-wider">Route</TableHead>
                <TableHead class="text-[11px] font-bold text-gray-500 uppercase tracking-wider">Documents</TableHead>
                <TableHead class="text-[11px] font-bold text-gray-500 uppercase tracking-wider">Status</TableHead>
                <TableHead class="text-[11px] font-bold text-gray-500 uppercase tracking-wider">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow v-for="row in store.loads" :key="row.loadId">
                <TableCell class="font-mono font-bold text-slate-900 align-top whitespace-nowrap">{{ row.loadId }}</TableCell>
                <TableCell class="align-top">{{ row.broker || '—' }}</TableCell>
                <TableCell class="align-top">{{ row.route || '—' }}</TableCell>
                <TableCell class="align-top">
                  <div class="flex flex-wrap gap-1.5">
                    <span
                      v-for="c in checklistOf(row)"
                      :key="c.key"
                      class="inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-semibold"
                      :class="c.ok ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-gray-50 text-gray-400 border-gray-200'"
                      :title="c.label + (c.ok ? ' — attached' : ' — missing')"
                    >
                      <span aria-hidden="true">{{ c.ok ? '✓' : '✗' }}</span>{{ c.label }}
                    </span>
                  </div>
                </TableCell>
                <TableCell class="align-top">
                  <span class="inline-flex items-center rounded-full border px-2 py-0.5 text-[0.62rem] font-bold uppercase tracking-wide whitespace-nowrap" :class="statusMeta(row.status).cls">{{ statusMeta(row.status).label }}</span>
                </TableCell>
                <TableCell class="align-top">
                  <div class="flex flex-col items-start gap-1.5 min-w-[180px]">
                    <a
                      v-if="row.status === 'drafted'"
                      :href="GMAIL_DRAFTS_URL"
                      target="_blank"
                      rel="noopener noreferrer"
                      class="inline-flex items-center gap-1.5 rounded-md bg-[#0f2847] hover:bg-[#1a3a5c] text-white text-[12px] font-semibold px-3 py-1.5 transition-colors whitespace-nowrap"
                      title="Open the Gmail Drafts folder — find the draft by its subject, review it, then send"
                    >
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 6L2 7"/></svg>
                      Review Draft
                    </a>
                    <Button
                      v-else
                      size="sm"
                      :disabled="generatingId === row.loadId"
                      @click="generateDraft(row)"
                    >{{ generatingId === row.loadId ? 'Generating…' : 'Generate Draft' }}</Button>

                    <div v-if="row.status === 'drafted' && row.draftSubject" class="flex items-center gap-1.5 max-w-full">
                      <span class="font-mono text-[11px] text-gray-500 truncate max-w-[220px]" :title="row.draftSubject">{{ row.draftSubject }}</span>
                      <button type="button" class="inline-flex items-center gap-1 rounded border border-gray-200 bg-white px-1.5 h-[22px] text-[11px] hover:bg-gray-50 transition-colors shrink-0" :class="copiedId === row.loadId ? 'text-emerald-600 border-emerald-200' : 'text-gray-500'" :title="copiedId === row.loadId ? 'Copied!' : 'Copy draft subject'" @click="copySubject(row)">{{ copiedId === row.loadId ? '✓ Copied' : '⧉ Copy' }}</button>
                    </div>
                    <div v-if="row.status === 'drafted' && (row.invoiceNumber || draftedWhen(row))" class="text-[11px] text-gray-400">
                      <span v-if="row.invoiceNumber" class="font-mono">#{{ row.invoiceNumber }}</span><span v-if="row.invoiceNumber && draftedWhen(row)"> · </span><span v-if="draftedWhen(row)">drafted {{ draftedWhen(row) }}</span>
                    </div>
                    <div v-if="row.status === 'pending' && row.lastError" class="text-[11px] text-red-600 leading-snug max-w-[240px]" :title="row.lastError">{{ row.lastError }}</div>
                    <div v-else-if="row.status === 'pending'" class="text-[11px] text-gray-400">Not drafted yet — generate when the rate-con is in.</div>
                  </div>
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </template>
      </CardContent>
    </Card>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { useBillingStore } from '../stores/billing'
import { useViewport } from '../composables/useViewport'
import { useToast } from '../composables/useToast'
import { useSocketRefresh } from '../composables/useSocketRefresh'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import EmptyState from '@/components/shared/EmptyState.vue'

// The queue's "Review Draft" button opens the shared Drafts folder; the specific
// draft is located by its subject (shown + copyable per row). The app never
// sends — a human reviews and sends from Gmail (the never-send rule).
const GMAIL_DRAFTS_URL = 'https://mail.google.com/mail/u/0/#drafts'

const store = useBillingStore()
const { isMobile } = useViewport()
const { show: toast } = useToast()

// A failed initial load shouldn't blank the page. notFound distinguishes a 404
// (endpoint built in parallel, not serving yet → soft empty copy) from any other
// error (generic, retryable).
const loadFailed = ref(false)
const notFound = ref(false)
const errorMsg = ref('')
const generatingId = ref(null)
const copiedId = ref(null)

const STATUS_META = {
  drafted: { label: 'Drafted', cls: 'bg-emerald-100 text-emerald-700 border-emerald-200' },
  pending: { label: 'Pending', cls: 'bg-amber-100 text-amber-700 border-amber-200' },
}
function statusMeta(status) {
  return STATUS_META[status] || { label: status || 'Unknown', cls: 'bg-gray-100 text-gray-600 border-gray-200' }
}

// The [✓ Rate Con][✓ BOL][✓ Invoice] checklist, driven straight off the contract's
// booleans.
function checklistOf(row) {
  return [
    { key: 'ratecon', label: 'Rate Con', ok: !!row.hasRateCon },
    { key: 'bol', label: 'BOL', ok: !!row.hasBol },
    { key: 'invoice', label: 'Invoice', ok: !!row.hasInvoice },
  ]
}

function draftedWhen(row) {
  if (!row.draftedAt) return ''
  const d = new Date(row.draftedAt)
  if (isNaN(d.getTime())) return ''
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

async function refresh() {
  loadFailed.value = false
  notFound.value = false
  errorMsg.value = ''
  try {
    await store.load()
  } catch (err) {
    loadFailed.value = true
    notFound.value = err.status === 404
    errorMsg.value = err.message || ''
  }
}

async function generateDraft(row) {
  if (generatingId.value) return
  generatingId.value = row.loadId
  try {
    const res = await store.generateDraft(row.loadId)
    toast(res && res.draftSubject ? `Draft staged: ${res.draftSubject}` : 'Draft generated')
  } catch (err) {
    toast((err && err.message) || 'Could not generate the draft', 'error')
  } finally {
    generatingId.value = null
    // Reload either way — a success flips the row to 'drafted'; a failure updates
    // its lastError. The GET succeeding here also clears any prior loadFailed.
    await refresh()
  }
}

async function copySubject(row) {
  const subject = (row.draftSubject || '').trim()
  if (!subject) return
  try {
    if (!navigator.clipboard || !navigator.clipboard.writeText) throw new Error('unavailable')
    await navigator.clipboard.writeText(subject)
    copiedId.value = row.loadId
    toast('Draft subject copied')
    setTimeout(() => { if (copiedId.value === row.loadId) copiedId.value = null }, 2000)
  } catch {
    toast('Could not copy — select and copy the subject manually', 'error')
  }
}

// A driver's BOL upload elsewhere emits pod-uploaded to the dispatch room; the
// server then stages the draft. Refresh so the new row surfaces without a manual
// reload (debounced inside the composable).
useSocketRefresh('pod-uploaded', refresh)

onMounted(refresh)
</script>
