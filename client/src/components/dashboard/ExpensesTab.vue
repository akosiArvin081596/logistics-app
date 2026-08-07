<template>
  <div class="expenses-tab">
    <!-- Sub-tabs -->
    <div class="sub-tabs">
      <button
        v-for="tab in subTabs"
        :key="tab.key"
        :class="['sub-tab', { active: activeSubTab === tab.key }]"
        @click="activeSubTab = tab.key"
      >{{ tab.label }}</button>
    </div>

    <!-- ALL EXPENSES -->
    <div v-show="activeSubTab === 'all'" class="sub-panel">
      <!-- Download Receipts — Super Admin only.
           Streams a ZIP of every receipt file for a specific truck in a
           date range, plus a manifest.csv for accounting review. -->
      <div v-if="auth.isSuperAdmin" class="download-receipts-card">
        <div class="download-receipts-title">
          <span>Download Receipts (ZIP)</span>
          <span class="download-receipts-hint">Bundle all receipts for a truck &amp; date range</span>
        </div>
        <div class="download-receipts-row">
          <select v-model="downloadForm.truck" class="add-input" style="max-width:180px" aria-label="Truck unit">
            <option value="">Select Truck *</option>
            <option v-for="t in truckList" :key="t" :value="t">{{ t }}</option>
          </select>
          <input v-model="downloadForm.from" type="date" class="add-input" style="max-width:160px" :max="downloadForm.to || todayIso" aria-label="From date" />
          <input v-model="downloadForm.to" type="date" class="add-input" style="max-width:160px" :min="downloadForm.from" :max="todayIso" aria-label="To date" />
          <button class="btn btn-primary" :disabled="!canDownload || downloadLoading" @click="downloadReceipts">
            {{ downloadLoading ? 'Preparing...' : 'Download ZIP' }}
          </button>
        </div>
        <div v-if="downloadError" class="download-receipts-error">{{ downloadError }}</div>
      </div>

      <!-- Add Expense form — Super Admin / Dispatcher only -->
      <div v-if="canAddExpense" class="add-expense-card">
        <div class="add-expense-title">Log Expense</div>
        <div class="add-expense-row">
          <select v-model="addForm.driver" class="add-input">
            <option value="">Select Driver *</option>
            <option v-for="d in allDrivers" :key="d" :value="d">{{ d }}</option>
          </select>
          <select v-model="addForm.type" class="add-input">
            <option v-for="t in expenseTypes" :key="t" :value="t">{{ t }}</option>
          </select>
          <input v-model="addForm.amount" type="number" step="0.01" min="0" placeholder="Amount *" class="add-input" style="max-width:120px" />
          <input v-model="addForm.date" type="date" class="add-input" style="max-width:150px" />
          <button class="btn btn-primary add-btn" :disabled="addLoading || photoProcessing" @click="submitExpense">{{ addLoading ? '...' : 'Add' }}</button>
        </div>
        <div class="add-expense-row">
          <!-- Fuel only. These drive cost-per-gallon and MPG; the form used to post
               a hardcoded 0, so every admin-entered fuel receipt was excluded from
               both. The OCR fills them on Enhance — this just stops discarding it. -->
          <template v-if="addForm.type === 'Fuel'">
            <input v-model="addForm.gallons" type="number" step="0.001" min="0" placeholder="Gallons" class="add-input" style="max-width:110px" :class="{ 'add-input-warn': addForm.amount && !(parseFloat(addForm.gallons) > 0) }" title="Without gallons this receipt won't count toward cost-per-gallon or MPG" />
            <input v-model="addForm.odometer" type="number" step="1" min="0" placeholder="Odometer" class="add-input" style="max-width:120px" />
          </template>
          <input v-model="addForm.loadId" type="text" placeholder="Load ID (optional)" class="add-input" style="max-width:180px" />
          <input v-model="addForm.city" type="text" placeholder="City (optional)" class="add-input" style="max-width:160px" />
          <input
            v-model="addForm.state"
            type="text"
            placeholder="ST"
            class="add-input"
            style="max-width:70px"
            maxlength="2"
            @input="addForm.state = addForm.state.toUpperCase()"
          />
          <input v-model="addForm.description" type="text" placeholder="Description (e.g., Tire repair paid via phone)" class="add-input" style="flex:1" />
        </div>
        <div class="add-expense-row add-expense-photo-row">
          <label class="add-photo-label">
            Receipt (photo or PDF)
            <!-- No capture attr (unlike the driver form): admins/dispatchers
                 pick files — a PDF toll invoice or a saved photo. Mobile still
                 offers the camera through the chooser. -->
            <input
              ref="fileInputRef"
              type="file"
              accept="image/*,.heic,.heif,application/pdf"
              class="add-photo-input"
              :disabled="addLoading || photoProcessing"
              @change="handleFileInput"
            />
          </label>
          <span v-if="photoProcessing" class="add-photo-hint">Processing file…</span>
          <span v-else-if="photoIsPdf" class="receipt-pdf-chip add-pdf-chip" :title="pdfName">PDF · {{ pdfName || 'receipt.pdf' }}</span>
          <img
            v-else-if="photoBase64"
            :src="photoBase64"
            class="receipt-thumb add-photo-preview"
            alt="Receipt preview"
            @click="previewImg = photoBase64"
          />
          <button
            v-if="photoBase64 && !photoProcessing"
            type="button"
            class="add-photo-clear"
            :disabled="addLoading"
            @click="clearPhoto"
          >Remove</button>
          <span
            v-if="ocrApplied && !photoProcessing"
            class="add-ocr-chip"
            :class="`add-ocr-${ocrConfidence || 'medium'}`"
          >
            ✓ Autofilled from receipt<span v-if="ocrConfidence"> · {{ ocrConfidence }} confidence</span>
            <button type="button" class="add-ocr-undo" @click="undoAddAutofill">Undo</button>
          </span>
          <!-- A confidently WRONG date is worse than a blank one: it files the
               expense in a year that isn't in the books, so it silently vanishes
               from its real month. Flag it; never block it. -->
          <span v-if="addDateSuspect" class="add-date-warn">⚠ {{ addDateSuspect }}</span>
        </div>
      </div>

      <template v-if="allLoading">
        <div class="skeleton skeleton-card"></div>
      </template>
      <template v-else>
        <div class="filter-row">
          <input
            v-model="allQ"
            type="search"
            class="filter-search"
            placeholder="Search vendor, description, city…"
            aria-label="Search expenses"
          />
          <select v-model="allFilter.driver" class="filter-select" @change="loadAll">
            <option value="">All Drivers</option>
            <option v-for="d in allDrivers" :key="d" :value="d">{{ d }}</option>
          </select>
          <select v-model="allFilter.truck" class="filter-select" @change="loadAll">
            <option value="">All Trucks</option>
            <option v-for="t in truckList" :key="t" :value="t">{{ t }}</option>
          </select>
          <select v-model="allFilter.type" class="filter-select" @change="loadAll">
            <option value="">All Types</option>
            <option v-for="t in expenseTypes" :key="t" :value="t">{{ t }}</option>
          </select>
          <select v-model="allFilter.status" class="filter-select" @change="loadAll">
            <option value="">All Status</option>
            <option>Pending</option>
            <option>Approved</option>
            <option>Rejected</option>
          </select>
          <select v-model="allFilter.state" class="filter-select" aria-label="Filter by state" @change="loadAll">
            <option value="">All States</option>
            <option v-for="s in US_STATES" :key="s.code" :value="s.code">{{ s.code }} — {{ s.name }}</option>
          </select>
          <input
            v-model="allFilter.from"
            type="date"
            class="filter-select"
            :max="allFilter.to || undefined"
            aria-label="From date"
            @change="loadAll"
          />
          <input
            v-model="allFilter.to"
            type="date"
            class="filter-select"
            :min="allFilter.from || undefined"
            aria-label="To date"
            @change="loadAll"
          />
          <span class="filter-count">{{ allExpenses.length }} expenses</span>
        </div>

        <!-- Bulk actions bar — appears once anything is selected. Approve is
             the owner's explicit ask; Reject rides the same endpoint. -->
        <div v-if="selectedIds.size > 0" class="bulk-bar">
          <span class="bulk-count">{{ selectedIds.size }} selected</span>
          <button class="bulk-btn bulk-approve" :disabled="bulkLoading" @click="bulkSetStatus('Approved')">{{ bulkLoading ? 'Working…' : 'Approve selected' }}</button>
          <button class="bulk-btn bulk-reject" :disabled="bulkLoading" @click="bulkSetStatus('Rejected')">Reject selected</button>
          <button class="bulk-clear" :disabled="bulkLoading" @click="clearSelection">Clear</button>
        </div>

        <!-- What the server actually committed. Lives OUTSIDE the bulk bar on
             purpose: a successful run clears the selection, which unmounts that
             bar, and this notice has to outlive the gesture that produced it.
             Renders only when something did not go through — a clean batch keeps
             its 3-second toast and adds nothing to the page.
             role="status" + aria-live="polite", matching MaintenanceBanner: it
             is a result to be read, not an interruption. -->
        <div v-if="bulkOutcome" class="bulk-outcome" role="status" aria-live="polite">
          <div class="bulk-outcome-top">
            <strong class="bulk-outcome-headline">{{ bulkOutcomeHeadline }}</strong>
            <button
              type="button"
              class="bulk-outcome-dismiss"
              aria-label="Dismiss this result"
              title="Dismiss"
              @click="bulkOutcome = null"
            >&times;</button>
          </div>
          <p v-for="(reason, i) in bulkOutcomeReasons" :key="i" class="bulk-outcome-reason">{{ reason }}</p>
          <p v-if="bulkOutcomeFootnote" class="bulk-outcome-foot">{{ bulkOutcomeFootnote }}</p>
        </div>

        <PaginationBar :page="page" :page-size="pageSize" :total="allExpenses.length" :total-pages="totalPages" @go="goTo" @size="setSize" />

        <div v-if="allExpenses.length === 0" class="empty-msg">No expenses found.</div>
        <!-- Mobile: card list. Tap the card → detail modal (shipped
             2026-04-20, already mobile-friendly). Approve / Reject full
             width in the card footer. -->
        <div v-else-if="isMobile" class="mobile-exp-list">
          <div v-for="e in paginatedItems" :key="e.id" class="mobile-exp-card" @click="openExpenseDetail(e)">
            <div class="mobile-exp-top">
              <label class="mobile-exp-select" @click.stop>
                <input
                  type="checkbox"
                  class="select-checkbox"
                  :checked="selectedIds.has(e.id)"
                  :aria-label="`Select expense ${e.id}`"
                  @change="toggleSelect(e.id)"
                />
              </label>
              <div class="mobile-exp-top-left">
                <div class="mobile-exp-date">{{ fmtDate(e.date) }}</div>
                <div class="mobile-exp-uploaded">
                  Uploaded {{ fmtUploaded(e.timestamp) }}
                  <span v-if="receiptDateSuspect(e)" class="date-warn" :title="receiptDateSuspect(e)">⚠</span>
                </div>
                <div class="mobile-exp-driver">{{ e.driver }}<span v-if="e.truck_unit" class="mobile-exp-truck"> · #{{ e.truck_unit }}</span></div>
                <div v-if="e.location_city || e.location_state" class="mobile-exp-location">{{ fmtLocation(e) }}</div>
                <div v-if="e.vendor" class="mobile-exp-vendor" :title="e.vendor_normalized || ''">{{ e.vendor }}</div>
              </div>
              <span :class="['type-pill', 'type-' + e.type.toLowerCase()]">{{ e.type }}</span>
            </div>
            <div v-if="e.description" class="mobile-exp-desc">{{ e.description }}</div>
            <div class="mobile-exp-bottom">
              <div class="mobile-exp-amount">${{ Number(e.amount).toLocaleString('en-US', { minimumFractionDigits: 2 }) }}</div>
              <div class="mobile-exp-bottom-right">
                <a v-if="isPdfReceipt(e.photo_data)" class="receipt-pdf-chip" :href="e.photo_data" target="_blank" rel="noopener" @click.stop>PDF</a>
                <img v-else-if="e.photo_data" :src="`/api/expenses/${e.id}/receipt-thumbnail`" loading="lazy" decoding="async" class="receipt-thumb mobile-exp-thumb" @click.stop="previewImg = e.photo_data" alt="Receipt" />
                <span :class="['status-pill', 'st-' + (e.status || 'Pending').toLowerCase()]">{{ e.status || 'Pending' }}</span>
              </div>
            </div>
            <div class="mobile-exp-actions" @click.stop>
              <template v-if="(e.status || 'Pending') === 'Pending'">
                <button class="btn-approve mobile-exp-btn" @click="setStatus(e.id, 'Approved')">Approve</button>
                <button class="btn-reject mobile-exp-btn" @click="setStatus(e.id, 'Rejected')">Reject</button>
              </template>
              <button v-else-if="e.status !== 'Pending'" class="btn-undo mobile-exp-btn" @click="setStatus(e.id, 'Pending')">Undo</button>
            </div>
          </div>
        </div>
        <!-- Desktop: existing table with new Truck column -->
        <table v-else class="data-table">
          <thead>
            <tr>
              <th class="select-cell">
                <!-- Select-all targets the Pending rows in the current
                     filtered view \u2014 the "approve everything I'm looking at"
                     flow. Any row can still be ticked individually. -->
                <input
                  type="checkbox"
                  class="select-checkbox"
                  :checked="allVisiblePendingSelected"
                  :indeterminate="selectedIds.size > 0 && !allVisiblePendingSelected"
                  :disabled="visiblePendingIds.length === 0 && selectedIds.size === 0"
                  title="Select all pending in view"
                  aria-label="Select all pending expenses in view"
                  @change="toggleSelectAllPending"
                />
              </th>
              <!-- "Date" alone was read as the upload date, which is what led to
                   "how could it be uploaded a day before the purchase". Naming it
                   and showing the upload time beside it removes the ambiguity. -->
              <th>Receipt Date</th>
              <th>Uploaded</th>
              <th>Driver</th>
              <th>Truck</th>
              <th>City / State</th>
              <th>Vendor</th>
              <th>Type</th>
              <th>Description</th>
              <th>Amount</th>
              <th>Receipt</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <!-- Same activation contract as the review queues below. The
                 keydown guard in rowKeyActivate is what keeps Space working on
                 this row's own select checkbox. -->
            <tr
              v-for="e in paginatedItems"
              :key="e.id"
              class="expense-row row-activatable"
              tabindex="0"
              :aria-label="`Open expense ${e.id} — ${e.driver}, ${fmtDate(e.date)}`"
              @click="openExpenseDetail(e)"
              @keydown="rowKeyActivate($event, () => openExpenseDetail(e))"
            >
              <td class="select-cell" @click.stop>
                <input
                  type="checkbox"
                  class="select-checkbox"
                  :checked="selectedIds.has(e.id)"
                  :aria-label="`Select expense ${e.id}`"
                  @change="toggleSelect(e.id)"
                />
              </td>
              <td class="mono-sm">
                {{ fmtDate(e.date) }}
                <span v-if="receiptDateSuspect(e)" class="date-warn" :title="receiptDateSuspect(e)">⚠</span>
              </td>
              <!-- e.timestamp, NOT e.created_at: the latter is UTC with no zone
                   marker and would render ~8h early. -->
              <td class="mono-sm upload-cell">{{ fmtUploaded(e.timestamp) }}</td>
              <td>{{ e.driver }}</td>
              <td class="mono-sm">{{ e.truck_unit ? '#' + e.truck_unit : '\u2014' }}</td>
              <td class="mono-sm">{{ fmtLocation(e) }}</td>
              <td class="desc-cell" :title="e.vendor_normalized || ''">{{ e.vendor || '—' }}</td>
              <td><span :class="['type-pill', 'type-' + e.type.toLowerCase()]">{{ e.type }}</span></td>
              <td class="desc-cell">{{ e.description || '\u2014' }}</td>
              <td class="mono-sm">${{ Number(e.amount).toLocaleString('en-US', { minimumFractionDigits: 2 }) }}</td>
              <td @click.stop>
                <a v-if="isPdfReceipt(e.photo_data)" class="receipt-pdf-chip" :href="e.photo_data" target="_blank" rel="noopener">PDF</a>
                <img v-else-if="e.photo_data" :src="`/api/expenses/${e.id}/receipt-thumbnail`" loading="lazy" decoding="async" class="receipt-thumb" @click="previewImg = e.photo_data" @mouseenter="showReceiptPreview(e, $event)" @mouseleave="hideReceiptPreview" />
                <span v-else class="dim">&mdash;</span>
              </td>
              <td>
                <span :class="['status-pill', 'st-' + (e.status || 'Pending').toLowerCase()]">{{ e.status || 'Pending' }}</span>
              </td>
              <td class="action-cell" @click.stop>
                <template v-if="(e.status || 'Pending') === 'Pending'">
                  <button class="btn-approve" @click="setStatus(e.id, 'Approved')">Approve</button>
                  <button class="btn-reject" @click="setStatus(e.id, 'Rejected')">Reject</button>
                </template>
                <button v-else-if="e.status !== 'Pending'" class="btn-undo" @click="setStatus(e.id, 'Pending')">Undo</button>
              </td>
            </tr>
          </tbody>
        </table>
      </template>

      <!-- Receipt preview overlay (zoom + pan) -->
      <ZoomableImage :src="previewImg" alt="Receipt" @close="previewImg = null" />

      <!-- Hover-to-zoom: a large receipt preview that appears beside the hovered
           row's thumbnail (no click needed). pointer-events:none so it never
           steals the mouse; click still opens the full zoomable lightbox. -->
      <Teleport to="body">
        <div
          v-if="hoverReceipt"
          class="receipt-hover-preview"
          :style="{ top: hoverReceipt.top + 'px', left: hoverReceipt.left + 'px', width: hoverReceipt.w + 'px', maxHeight: hoverReceipt.maxH + 'px' }"
        >
          <img :src="hoverReceipt.src" alt="Receipt preview" />
        </div>
      </Teleport>

      <!-- Expense breakdown modal. Opens on row click. Shows the same fields
           that live in the DB but aren't in the list (gallons, odometer,
           derived price-per-gallon) plus a bigger receipt preview.
           Prev/Next cycles through the current filtered list; Approve/Reject
           inside the modal auto-advance to the next Pending row. -->
      <Teleport to="body">
        <div v-if="selectedExpense" class="exp-overlay" @click.self="closeExpenseDetail">
          <div class="exp-dialog exp-dialog--full">
            <div class="exp-main">
              <!-- LEFT column — all expense details (scrolls internally only if it overflows) -->
              <div class="exp-details">
                <div class="exp-nav">
                  <button class="exp-nav-btn" :disabled="!canGoPrev" @click="goPrev" aria-label="Previous pending expense" title="Previous pending (←)">&larr; Prev</button>
                  <span class="exp-nav-counter">
                    <template v-if="isCurrentPending">Pending {{ pendingPos + 1 }} of {{ pendingIndices.length }}</template>
                    <template v-else-if="pendingIndices.length > 0">Viewing {{ (selectedExpense?.status || 'Pending').toLowerCase() }} · {{ pendingIndices.length }} pending remain</template>
                    <template v-else>No pending expenses</template>
                  </span>
                  <button class="exp-nav-btn" :disabled="!canGoNext" @click="goNext" aria-label="Next pending expense" title="Next pending (→)">Next &rarr;</button>
                </div>
                <div class="exp-details-scroll">
                  <div class="exp-header">
                    <div>
                      <div class="exp-type" :class="'type-' + (selectedExpense.type || 'other').toLowerCase()">{{ selectedExpense.type || 'Other' }}</div>
                      <div class="exp-amount">${{ Number(selectedExpense.amount).toLocaleString('en-US', { minimumFractionDigits: 2 }) }}</div>
                      <div class="exp-sub">Receipt {{ fmtDate(selectedExpense.date) }} &middot; {{ selectedExpense.driver }}</div>
                      <div class="exp-sub exp-sub-dim">Uploaded {{ fmtUploaded(selectedExpense.timestamp) }}</div>
                    </div>
                    <button class="exp-close" @click="closeExpenseDetail" aria-label="Close (Esc)">&times;</button>
                  </div>
                  <div class="exp-grid">
                    <template v-if="isFuelExpense(selectedExpense)">
                      <div class="exp-stat">
                        <span class="exp-stat-label">Gallons</span>
                        <span class="exp-stat-value">{{ Number(selectedExpense.gallons || 0).toFixed(2) }}</span>
                      </div>
                      <div class="exp-stat">
                        <span class="exp-stat-label">Price / Gallon</span>
                        <span class="exp-stat-value">${{ pricePerGallon(selectedExpense) }}</span>
                      </div>
                      <div class="exp-stat">
                        <span class="exp-stat-label">Odometer</span>
                        <span class="exp-stat-value">{{ selectedExpense.odometer ? Number(selectedExpense.odometer).toLocaleString() : '—' }}</span>
                      </div>
                    </template>
                    <div class="exp-stat">
                      <span class="exp-stat-label">Status</span>
                      <span class="exp-stat-value">
                        <span :class="['status-pill', 'st-' + (selectedExpense.status || 'Pending').toLowerCase()]">{{ selectedExpense.status || 'Pending' }}</span>
                      </span>
                    </div>
                    <div v-if="selectedExpense.load_id" class="exp-stat">
                      <span class="exp-stat-label">Load</span>
                      <span class="exp-stat-value mono-sm">{{ selectedExpense.load_id }}</span>
                    </div>
                    <div v-if="selectedExpense.truck_unit" class="exp-stat">
                      <span class="exp-stat-label">Truck</span>
                      <span class="exp-stat-value">#{{ selectedExpense.truck_unit }}</span>
                    </div>
                    <div class="exp-stat exp-stat-location">
                      <span class="exp-stat-label">Vendor</span>
                      <template v-if="editingVendor">
                        <div class="loc-edit-row">
                          <input
                            v-model="vendorDraft"
                            type="text"
                            class="loc-input"
                            placeholder="Vendor (e.g., Pilot Flying J)"
                            aria-label="Vendor"
                          />
                        </div>
                        <div class="loc-edit-actions">
                          <button class="loc-save" :disabled="savingVendor" @click="saveVendor">{{ savingVendor ? '…' : 'Save' }}</button>
                          <button class="loc-cancel" :disabled="savingVendor" @click="editingVendor = false">Cancel</button>
                        </div>
                      </template>
                      <span v-else class="exp-stat-value exp-stat-value-loc">
                        <span :title="selectedExpense.vendor_normalized || ''">{{ selectedExpense.vendor || '—' }}</span>
                        <button class="loc-edit-btn" @click="startEditVendor" aria-label="Edit vendor">Edit</button>
                      </span>
                    </div>
                    <div class="exp-stat exp-stat-location">
                      <span class="exp-stat-label">City / State</span>
                      <template v-if="editingLocation">
                        <div class="loc-edit-row">
                          <input
                            v-model="locDraft.city"
                            type="text"
                            class="loc-input"
                            placeholder="City"
                            aria-label="City"
                          />
                          <input
                            v-model="locDraft.state"
                            type="text"
                            class="loc-input loc-input-state"
                            placeholder="ST"
                            maxlength="2"
                            aria-label="State (2-letter)"
                            @input="locDraft.state = locDraft.state.toUpperCase()"
                          />
                        </div>
                        <div class="loc-edit-actions">
                          <button class="loc-save" :disabled="savingLocation" @click="saveLocation">{{ savingLocation ? '…' : 'Save' }}</button>
                          <button class="loc-cancel" :disabled="savingLocation" @click="editingLocation = false">Cancel</button>
                        </div>
                      </template>
                      <span v-else class="exp-stat-value exp-stat-value-loc">
                        {{ fmtLocation(selectedExpense) }}
                        <button class="loc-edit-btn" @click="startEditLocation" aria-label="Edit city and state">Edit</button>
                      </span>
                    </div>
                  </div>
                  <div v-if="selectedExpense.description" class="exp-desc">
                    <div class="exp-desc-label">Description</div>
                    <div>{{ selectedExpense.description }}</div>
                  </div>
                  <!-- Receipt Details — dynamic label/value pairs parsed from the stored receipt -->
                  <div v-if="(selectedExpense.receipt_details || []).length" class="exp-rd">
                    <div class="exp-desc-label">Receipt Details</div>
                    <dl class="exp-rd-list">
                      <div v-for="(d, i) in selectedExpense.receipt_details" :key="i" class="exp-rd-row">
                        <dt class="exp-rd-label">{{ d.label }}</dt>
                        <dd class="exp-rd-value">{{ d.value }}</dd>
                      </div>
                    </dl>
                    <button
                      v-if="canExtractDetails"
                      class="exp-rd-rescan"
                      :disabled="extractingDetails"
                      @click="extractReceiptDetails"
                    >{{ extractingDetails ? 'Re-scanning…' : 'Re-scan receipt' }}</button>
                  </div>
                  <div v-else-if="canExtractDetails" class="exp-rd">
                    <div class="exp-desc-label">Receipt Details</div>
                    <div class="exp-rd-empty">
                      <p class="exp-rd-hint">Scan the stored receipt to pull line items, tax, and payment details.</p>
                      <button class="exp-rd-extract" :disabled="extractingDetails" @click="extractReceiptDetails">
                        {{ extractingDetails ? 'Scanning…' : 'Extract details' }}
                      </button>
                    </div>
                  </div>
                </div>
                <div class="exp-actions">
                  <template v-if="(selectedExpense.status || 'Pending') === 'Pending'">
                    <button class="exp-btn-approve" :disabled="approveLoading" @click="approveCurrent">{{ approveLoading ? '…' : 'Approve' }}</button>
                    <button class="exp-btn-reject" :disabled="approveLoading" @click="rejectCurrent">{{ approveLoading ? '…' : 'Reject' }}</button>
                  </template>
                  <button v-else class="exp-btn-undo" :disabled="approveLoading" @click="undoCurrent">{{ approveLoading ? '…' : 'Undo' }}</button>
                </div>
              </div>
              <!-- RIGHT column — receipt, large + contained so the whole thing is readable -->
              <div class="exp-receipt-pane">
                <div class="exp-desc-label exp-receipt-label">Receipt</div>
                <template v-if="selectedExpense.photo_data">
                  <template v-if="isPdfReceipt(selectedExpense.photo_data)">
                    <div class="exp-receipt-pdf-wrap">
                      <a class="exp-receipt-pdf" :href="selectedExpense.photo_data" target="_blank" rel="noopener">Open PDF receipt</a>
                      <div class="exp-receipt-hint">Opens in a new tab</div>
                    </div>
                  </template>
                  <template v-else>
                    <div class="exp-receipt-imgwrap">
                      <ZoomableImage inline :src="selectedExpense.photo_data" alt="Receipt" />
                    </div>
                    <div class="exp-receipt-hint">Scroll or double-click to zoom &middot; drag to pan</div>
                  </template>
                </template>
                <div v-else class="exp-receipt-empty">
                  <svg width="46" height="46" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1Z" />
                    <path d="M8 7h8M8 11h8M8 15h5" />
                  </svg>
                  <span>No receipt attached</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </Teleport>
    </div>

    <!-- BULK RECEIPT UPLOAD — Super Admin / Dispatcher.
         v-show (not v-if) so an in-progress batch — uploaded receipts, OCR
         reads, hand-corrections — survives the admin flipping to another
         sub-tab and back. Unmounting here would silently discard all of it. -->
    <div v-show="activeSubTab === 'bulk'" class="sub-panel">
      <BulkReceiptScan
        v-if="canAddExpense"
        :drivers="allDrivers"
        :expense-types="expenseTypes"
        @saved="onBulkSaved"
      />
    </div>

    <!-- FUEL LOGS -->
    <div v-show="activeSubTab === 'fuel'" class="sub-panel">
      <template v-if="fuelLoading">
        <div class="skeleton skeleton-card"></div>
      </template>
      <template v-else>
        <!-- Reconciliation bar — the ActiveLoadsTab "Needs Review" affordance,
             transplanted. Renders ONLY when this server actually answers the
             "did every fuel-up meet a receipt?" question: an older build sends
             neither array, and staying quiet there is the honest degrade,
             because an empty queue and an unanswerable one mean opposite
             things. Toggling one narrows the panel to that queue, exactly as
             the load filter narrows its table. -->
        <div v-if="fuelReviewAvailable" class="fuel-review-bar">
          <button
            v-for="q in reviewToggles"
            :key="q.key"
            type="button"
            :style="fuelReviewToggleStyle(q.key)"
            :aria-pressed="reviewFocus === q.key"
            :title="reviewFocus === q.key ? q.onTitle : q.offTitle"
            @click="toggleReviewFocus(q.key)"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="margin-right:0.35rem;" aria-hidden="true"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
            {{ q.label }} {{ queueCountText(q) }}
          </button>
          <span v-if="reviewClearText" class="fuel-review-clear">{{ reviewClearText }}</span>
        </div>

        <div v-if="!reviewFocus" class="metrics-grid">
          <div class="metric-card">
            <div class="metric-label">Total Fuel Spend</div>
            <div class="metric-value">${{ fuel.totalFuelSpend?.toLocaleString() || 0 }}</div>
          </div>
          <div class="metric-card">
            <div class="metric-label">Total Gallons</div>
            <div class="metric-value">{{ fuel.totalGallons || 0 }}</div>
          </div>
          <!-- The currency sign lives INSIDE the branch: with no gallons on file
               this divides to 0 and the old markup rendered a literal "$—". -->
          <div class="metric-card">
            <div class="metric-label">Avg $/Gallon</div>
            <div class="metric-value" :class="{ 'metric-value-empty': !fuel.avgCostPerGallon }">
              {{ fuel.avgCostPerGallon ? '$' + fuel.avgCostPerGallon : '—' }}
            </div>
            <div v-if="!fuel.avgCostPerGallon && !fuel.totalGallons" class="metric-sub metric-sub-empty" title="Average price per gallon needs gallons to divide by. No fuel receipt on file records a volume yet — the “Receipts missing gallons” queue below is where that comes from.">
              No gallons recorded yet
            </div>
          </div>
          <!-- Cost/mile is a FLOOR, not a measurement: the miles span the whole
               truck while the spend only counts receipts we actually hold, so
               every missing receipt pushes it down. The basis line is what stops
               it being read as exact — and it is also the number that moves as
               the review queue on this same screen gets worked through. When
               there is no basis at all, the same line says so outright instead
               of leaving a bare dash to be read as a failure. -->
          <div class="metric-card">
            <div class="metric-label">Cost/Mile</div>
            <div class="metric-value" :class="{ 'metric-value-empty': cpm.empty }">{{ cpm.value }}</div>
            <div
              v-if="cpm.note"
              class="metric-sub"
              :class="{ 'metric-sub-empty': cpm.empty }"
              :title="cpm.title"
            >{{ cpm.note }}</div>
          </div>
        </div>

        <!-- TANK CALIBRATION — configured capacity next to the capacity the
             truck's own fills imply. An OBSERVATION beside a CONFIGURATION:
             nothing here writes, and the copy points at the one place a human
             changes it. #33 is configured at 300 gal and its fills imply ~117,
             which is why the sample count sits next to the number instead of
             being hidden behind it. -->
        <div v-if="!reviewFocus && calibrationRows.length" class="section-card">
          <div class="section-title cal-title">
            <span>Tank Calibration &amp; Measured MPG</span>
            <span v-if="calibrationCheckCount" class="cal-count-badge" title="Trucks whose implied capacity is more than 20% away from the capacity configured on the truck record, or that have no capacity configured at all.">
              {{ calibrationCheckCount }} to review
            </span>
          </div>
          <p class="cal-note">
            Gallons implied by a full 0&rarr;100% swing in the ELD fuel level, next to the capacity set on
            the truck. A large gap usually means the configured capacity is wrong &mdash; which quietly
            overstates every fuel-range estimate a driver sees. Implied is an observation, not a correction:
            change a capacity in <strong>Trucks &rarr; Edit &rarr; Fuel Tank, MPG &amp; Business Configuration</strong>.
          </p>
          <!-- The twin-tank explanation. Without it the numbers below look like
               noise: #33's fills split into two clusters ~117 and ~230, so a
               plain median lands on 143.5 and matches no real tank. Saying this
               once, here, is what lets someone answer "why is it configured at
               300 but implying 117?" without asking anyone. -->
          <p v-if="calibrationBimodal" class="cal-note cal-note-flag">
            <strong>Twin-tank pattern detected.</strong> Fills on the flagged trucks fall into two groups
            about 2&times; apart &mdash; the signature of two saddle tanks with a sensor on only one of them.
            A fill that tops up just the sensed tank and one that tops up both move the needle the same
            distance for double the fuel. The figure shown is the <em>lower</em> group, i.e. the gallons
            behind one full sweep of the sensor, because that is what converts a fuel percentage into
            gallons and therefore what the driver's range estimate rests on. Neither group is wrong;
            averaging them would invent a tank that doesn't exist.
          </p>
          <table>
            <thead>
              <tr>
                <th>Truck</th>
                <th>Configured</th>
                <th title="Gallons behind one full 0→100% sweep of the fuel sensor.">Implied</th>
                <th>Implied range</th>
                <th>Fills</th>
                <th title="Miles per gallon measured from ELD odometer miles and pump gallons off the receipts — no tank sensor and no tank-size assumption in the path.">Measured MPG</th>
                <th>Comparison</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="c in calibrationRows" :key="c.vehicleId || c.unitNumber" :class="{ 'cal-row-check': c.status === 'check' || c.status === 'no-config' }">
                <td class="mono">{{ c.unitNumber }}</td>
                <td class="mono">
                  <span v-if="c.configured !== null">{{ c.configured }} gal</span>
                  <span v-else class="cal-unset" title="No tank size recorded on this truck — the fuel-range estimate falls back to the 200 gal fleet default.">Not set</span>
                </td>
                <td class="mono">
                  <template v-if="c.implied !== null">
                    {{ c.implied }} gal
                    <span
                      v-if="c.impliedBasis === 'lower-mode'"
                      class="cal-thin cal-basis"
                      :title="`Per sensor sweep. Fills topping up both tanks show about 2× this. Median across all ${c.sampleCount} fills is ${c.median} gal, which is between the two groups and matches neither.`"
                    >per sweep</span>
                  </template>
                  <span v-else>—</span>
                </td>
                <td class="mono cal-range">{{ calibrationRange(c) }}</td>
                <td class="mono">
                  {{ c.sampleCount }}
                  <span v-if="c.thin" class="cal-thin" title="Fewer than 3 fills behind this figure — directional, not settled.">thin</span>
                </td>
                <td class="mono">
                  <template v-if="c.receiptMpg !== null">
                    {{ c.receiptMpg }} mpg
                    <span class="cal-thin" :title="`Measured across ${c.mpgLegCount} tank-to-tank leg(s).`">{{ c.mpgLegCount }} legs</span>
                  </template>
                  <span v-else class="cal-unset" title="Not enough matched fills on this truck yet to measure MPG from receipts.">—</span>
                </td>
                <td>
                  <span
                    v-if="c.status === 'check' || c.status === 'no-config'"
                    class="cal-badge"
                    :title="c.status === 'no-config' ? 'Set this truck’s real capacity so the driver fuel-range estimate stops using the fleet default.' : 'Implied and configured capacity disagree by more than 20%. Worth confirming the real tank size before trusting range or MPG for this truck.'"
                  >&#9888; {{ calibrationVerdict(c) }}</span>
                  <span v-else class="cal-ok">{{ calibrationVerdict(c) }}</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- REVIEW QUEUE 1 — the ELD saw the tank rise, nothing was filed. -->
        <div v-if="showFillsQueue" class="section-card review-card">
          <div class="section-title cal-title">
            <span>Fuel-ups without a receipt</span>
            <span v-if="unmatchedFillRows.length" class="cal-count-badge">{{ unmatchedFillRows.length }}</span>
          </div>
          <p class="cal-note">
            The truck's tank rose but no fuel receipt is on file for that truck and day &mdash; usually a
            receipt that hasn't been uploaded yet. Each one is fuel spend the carrier currently can't
            account for.
          </p>
          <table v-if="unmatchedFillRows.length">
            <thead>
              <tr>
                <th>Date</th>
                <th>Time</th>
                <th>Truck</th>
                <th>Tank</th>
                <th>Odo (ELD)</th>
              </tr>
            </thead>
            <tbody>
              <!-- DELIBERATELY not row-activatable, unlike the three queues
                   below. This is the one queue whose rows have nothing to open:
                   its whole subject is a fuel-up with NO receipt behind it, so
                   there is no expense to route to. Giving these rows a tabindex
                   for symmetry would put five stops in the tab order that answer
                   Enter with nothing — a promise of an action that does not
                   exist, which is the same class of untruth as a row rendering
                   as approved when it wasn't. Leave them as data. -->
              <tr v-for="f in unmatchedFillRows" :key="f.key">
                <td class="mono">{{ fmtYmd(f.localDay) }}</td>
                <td class="mono">{{ f.atMs ? fmtHM(new Date(f.atMs).toISOString()) : '—' }}</td>
                <td class="mono">
                  {{ f.label }}
                  <span v-if="f.showUnlinked" class="odo-src odo-src-none" title="No LogisX truck is linked to this ELD device, so the fill can't be attributed to a unit number.">unlinked</span>
                </td>
                <td class="mono">{{ tankRiseText(f) }}</td>
                <td class="mono">{{ fmtOdometer(f.odometer) }}</td>
              </tr>
            </tbody>
          </table>
          <div v-else class="empty-msg">
            No unmatched fuel-ups — every tank rise the ELD detected has a receipt filed against it.
          </div>
        </div>

        <!-- REVIEW QUEUE 2 — a receipt exists, the tank never moved. -->
        <div v-if="showReceiptsQueue" class="section-card review-card">
          <div class="section-title cal-title">
            <span>Receipts without a fuel-up</span>
            <span v-if="unmatchedReceiptRows.length" class="cal-count-badge">{{ unmatchedReceiptRows.length }}</span>
          </div>
          <p class="cal-note">
            A fuel receipt is on file but no matching rise was detected in that truck's tank. Most often the
            truck on the receipt is wrong, or the truck has no ELD link so there is nothing to match against.
            Worth a second look either way.
          </p>
          <!-- No Driver column: this payload joins expenses to TRUCKS, not to
               drivers, so there is no driver on the wire. A column that renders
               an em dash on every row is worse than no column — it reads as
               "this receipt has no driver" rather than "we didn't ask". The
               driver is one click away in the detail modal each row opens. -->
          <table v-if="unmatchedReceiptRows.length">
            <thead>
              <tr>
                <th>Date</th>
                <th>Truck</th>
                <th>Vendor</th>
                <th>Gal</th>
                <th>Amount</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="r in unmatchedReceiptRows"
                :key="r.id"
                class="review-row-clickable row-activatable"
                tabindex="0"
                title="Open this receipt"
                aria-label="Open this receipt"
                @click="openReceiptRow(r)"
                @keydown="rowKeyActivate($event, () => openReceiptRow(r))"
              >
                <td class="mono">{{ fmtYmd(r.localDay) }}</td>
                <td class="mono">{{ r.truckUnit || '—' }}</td>
                <td>{{ r.vendor || '—' }}</td>
                <td class="mono">{{ r.gallons !== null ? r.gallons : '—' }}</td>
                <td class="mono">{{ r.amount !== null ? '$' + r.amount.toFixed(2) : '—' }}</td>
              </tr>
            </tbody>
          </table>
          <div v-else class="empty-msg">
            No unmatched receipts — every fuel receipt on file lines up with a detected fuel-up.
          </div>
        </div>

        <!-- REVIEW QUEUE 3 — a receipt with money on it and no volume.
             Distinct from queue 2 and not merged with it: queue 2 is "we can't
             find the fuel-up behind this receipt", this is "the receipt itself
             is incomplete". Different diagnosis, different fix, different
             person. This is the largest and cheapest-to-clear of the four. -->
        <div v-if="showVolumelessQueue" class="section-card review-card">
          <!-- Two badges, never one summed number: the amber one is work, the
               grey one is rows a human cannot act on. A single "12" covering
               both would send someone looking for twelve fixable receipts and
               leave them to discover five were closed. -->
          <div class="section-title cal-title">
            <span>Receipts missing gallons</span>
            <span v-if="volumelessCounts.actionable" class="cal-count-badge" title="Receipts in an open month — these can still be corrected.">{{ volumelessCounts.actionable }} to fix</span>
            <span v-if="volumelessCounts.closed" class="closed-count-badge" title="Receipts whose month has been finalized by month-end close. Listed so the gap is visible, but they can no longer be edited.">{{ volumelessCounts.closed }} closed</span>
          </div>
          <p class="cal-note">
            A fuel receipt with a dollar amount but no gallons recorded. Without the volume there is no
            price per gallon and no tank-to-tank leg to measure against, so the truck can't establish its
            own MPG and every range estimate its driver sees falls back to the fleet default. Each row is
            a two-minute fix: open the receipt, read the gallons off it, type them in.
            <template v-if="volumelessCounts.closed">
              Rows marked <em>closed</em> sit in a finalized month and can't be edited — they stay listed
              so the gap in the data is still visible.
            </template>
          </p>
          <!-- The per-truck rollup. This is what turns a long list of individual
               rows into a single actionable sentence about one truck — without
               it, a reviewer has to count the Truck column by eye to notice that
               almost all of them are the same vehicle. -->
          <div v-if="volumelessTotals" class="vol-summary">
            <!-- The headline is a statement of FACT about the data and stays
                 whole — closed months included — because the money really is
                 unaccounted for either way. The line under it is the call to
                 action, and that one is scoped to what can actually be done. -->
            <div class="vol-headline">
              <strong>{{ fmtMoney(volumelessTotals.totalAmount) }}</strong> of diesel across
              <strong>{{ volumelessTotals.count }}</strong>
              receipt{{ volumelessTotals.count === 1 ? '' : 's' }} has no volume recorded against it.
            </div>
            <div v-if="volumelessCounts.closed" class="vol-split">
              <template v-if="!volumelessShowingAll">Of the {{ volumelessRows.length }} listed below, </template>
              <strong>{{ volumelessCounts.actionable }}</strong> can still be corrected;
              <strong>{{ volumelessCounts.closed }}</strong>
              {{ volumelessCounts.closed === 1 ? 'falls' : 'fall' }} in months that month-end close has
              already finalized and are listed for reference only.
            </div>
            <!-- The table is not the whole story. Saying so is the difference
                 between a reviewer working the list to zero and a reviewer
                 believing they already have. -->
            <div v-if="!volumelessShowingAll" class="vol-split">
              Showing the {{ volumelessRows.length }} most recent of {{ volumelessTotals.count }}.
            </div>
            <div v-if="volumelessTotals.byTruck.length" class="vol-trucks">
              <span v-for="t in volumelessTotals.byTruck" :key="t.truckUnit || 'unassigned'" class="vol-truck-chip">
                <span class="vol-truck-unit">{{ t.truckUnit || 'No truck on receipt' }}</span>
                <span class="vol-truck-stat">
                  {{ t.count }} receipt{{ t.count === 1 ? '' : 's' }} &middot; {{ fmtMoney(t.totalAmount) }}
                </span>
              </span>
            </div>
          </div>
          <!-- Driver column, unlike the queue above: this payload carries the
               driver off the expense row itself, so the column is real here and
               would have been an em-dash placeholder there. -->
          <table v-if="volumelessRows.length">
            <thead>
              <tr>
                <th>Date</th>
                <th>Truck</th>
                <th>Vendor</th>
                <th>Driver</th>
                <th>Amount</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="r in volumelessRows"
                :key="r.id"
                class="row-activatable"
                :class="r.locked === true ? 'review-row-locked' : 'review-row-clickable'"
                tabindex="0"
                :aria-disabled="r.locked === true ? 'true' : null"
                :title="reviewRowAction(r, 'Open this receipt to add the gallons')"
                :aria-label="reviewRowAction(r, 'Open this receipt to add the gallons')"
                @click="openReceiptRow(r)"
                @keydown="rowKeyActivate($event, () => openReceiptRow(r))"
              >
                <td class="mono">
                  {{ fmtYmd(r.localDay) }}
                  <span v-if="r.locked === true" class="closed-chip" :title="`${r.periodLabel || 'This month'} was finalized by month-end close.`">closed</span>
                </td>
                <td class="mono">{{ r.truckUnit || '—' }}</td>
                <td>{{ r.vendor || '—' }}</td>
                <td>{{ r.driver || '—' }}</td>
                <td class="mono">{{ fmtMoney(r.amount) }}</td>
              </tr>
            </tbody>
          </table>
          <div v-else class="empty-msg">
            No fuel receipts are missing gallons — every one on file records the volume pumped.
          </div>
        </div>

        <!-- REVIEW QUEUE 4 — the typed odometer and the machine disagree.
             The only queue here that isn't about a missing document: the paper
             exists and one number on it is wrong. -->
        <div v-if="showOdometerQueue" class="section-card review-card">
          <div class="section-title cal-title">
            <span>Odometer conflicts</span>
            <span v-if="odometerCounts.actionable" class="cal-count-badge" title="Conflicts on a receipt in an open month — these can still be corrected.">{{ odometerCounts.actionable }} to fix</span>
            <span v-if="odometerCounts.closed" class="closed-count-badge" title="Conflicts on a receipt whose month has been finalized by month-end close. Listed so the bad reading is visible, but it can no longer be edited.">{{ odometerCounts.closed }} closed</span>
          </div>
          <p class="cal-note">
            The odometer typed on the receipt disagrees with what the truck's ELD read at the moment its
            tank rose. The ELD figure is machine-read at the fill; the receipt figure was entered by hand,
            so <strong>the receipt is the one to correct</strong> — open the row and check it against the
            paper. One bad reading is enough to distort fleet-wide cost-per-mile on its own.
            <template v-if="odometerCounts.closed">
              Rows marked <em>closed</em> sit in a finalized month and can't be edited — they stay listed
              because the reading is still wrong and still worth knowing about.
            </template>
          </p>
          <!-- Deliberately NOT date-limited, and saying so here stops the next
               reader "tidying up" the queue with a filter. The two conflicts
               that exist in this fleet are both older than the 45-day window
               the queues above use, so any window at all would hide exactly the
               rows this queue was built to surface. -->
          <p class="cal-note cal-note-flag">
            <strong>Not limited to recent activity.</strong> The queues above are work that decays — a
            missing receipt from three months ago is history. A wrong odometer on a finance row is not:
            it stays wrong, and keeps distorting cost-per-mile, until a human edits it. So this list
            reaches back over everything on file.
          </p>
          <table v-if="odometerConflictRows.length">
            <thead>
              <tr>
                <th>Receipt date</th>
                <th>Truck</th>
                <th title="The reading entered by hand on the receipt. This is the value under suspicion.">On the receipt</th>
                <th title="The truck's own odometer, read by the ELD at the moment the tank rose.">From the ELD</th>
                <th>Difference</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="c in odometerConflictRows"
                :key="c.id"
                class="row-activatable"
                :class="c.locked === true ? 'review-row-locked' : 'review-row-clickable'"
                tabindex="0"
                :aria-disabled="c.locked === true ? 'true' : null"
                :title="reviewRowAction(c, 'Open this receipt to correct the odometer')"
                :aria-label="reviewRowAction(c, 'Open this receipt to correct the odometer')"
                @click="openReceiptRow(c)"
                @keydown="rowKeyActivate($event, () => openReceiptRow(c))"
              >
                <td class="mono">
                  {{ fmtYmd(c.receiptDate || c.localDay) }}
                  <span v-if="c.locked === true" class="closed-chip" :title="`${c.periodLabel || 'This month'} was finalized by month-end close.`">closed</span>
                </td>
                <td class="mono">{{ c.unitNumber || '—' }}</td>
                <!-- The suspect value is styled as suspect, not as one of two
                     equal candidates: amber, underlined, and chipped "typed".
                     A bare 1 sitting next to 851,991 in identical type reads as
                     a puzzle; like this it reads as a typo. -->
                <td class="mono odo-cell">
                  <span class="odo-value odo-conflict-suspect">{{ fmtOdometer(c.receiptOdometer) }}</span>
                  <span class="odo-src odo-src-receipt" title="Hand-entered by whoever filed this receipt.">typed</span>
                  <span v-if="c.grosslyLow" class="odo-src odo-src-suspect" title="Far too low to be a tractor's odometer at all — almost certainly a mis-key rather than a stale reading.">check</span>
                </td>
                <td class="mono odo-cell">
                  <span class="odo-value odo-derived">{{ fmtOdometer(c.eldOdometer) }}</span>
                  <span class="odo-src odo-src-telemetry" title="Read from the truck's ELD at the moment the tank rose — not written on the paper.">ELD</span>
                </td>
                <td class="mono odo-conflict-delta">
                  {{ conflictDeltaText(c) }}
                  <span v-if="c.direction" class="cal-thin">receipt reads {{ c.direction }}</span>
                </td>
              </tr>
            </tbody>
          </table>
          <div v-else class="empty-msg">
            No odometer conflicts — every hand-entered reading agrees with the truck's ELD.
          </div>
        </div>

        <!-- Savings target -->
        <div v-if="!reviewFocus" class="compliance-card">
          <div class="compliance-header">
            <span>Route Compliance — 15% Savings Target</span>
            <span :class="['compliance-badge', fuel.onTarget ? 'on-target' : 'off-target']">
              {{ fuel.onTarget ? 'On Target' : 'Below Target' }}
            </span>
          </div>
          <div class="progress-bar">
            <div
              class="progress-fill"
              :class="{ danger: !fuel.onTarget }"
              :style="{ width: Math.min(100, Math.max(0, (fuel.savingsVsNational / fuel.savingsTarget) * 100)) + '%' }"
            ></div>
          </div>
          <div class="compliance-detail">
            {{ fuel.savingsVsNational || 0 }}% vs national avg ($3.80/gal) — Target: {{ fuel.savingsTarget || 15 }}%
          </div>
        </div>

        <!-- Monthly trend. $/Gal is the one column here that is a DERIVED figure
             rather than a total, and it is derived across two populations —
             spend counts every receipt, gallons only the ones that recorded a
             volume. So it carries its basis the way Cost/Mile does, and for the
             same reason: a reader must be able to tell a measurement from a
             quotient with half its denominator missing. -->
        <div v-if="!reviewFocus && fuelMonthRows.length" class="section-card">
          <div class="section-title">Monthly Fuel Spend</div>
          <table>
            <thead>
              <tr>
                <th>Month</th>
                <th>Spend</th>
                <th>Gallons</th>
                <th title="A month's spend divided by the gallons recorded that month. Receipts filed without a volume count in the spend and not in the gallons, so a month holding any of them is marked and its price reads as an upper bound.">$/Gal</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="m in fuelMonthRows" :key="m.month">
                <td class="mono">{{ m.month }}</td>
                <td>${{ m.spend.toLocaleString() }}</td>
                <td>{{ m.gallons }}</td>
                <td class="mono fuel-mo-rate">
                  <span :class="{ 'fuel-mo-unmeasured': m.empty }" :title="m.title">{{ m.value }}</span>
                  <span v-if="m.flag" class="cal-thin fuel-mo-flag" :title="m.title">{{ m.flag }}</span>
                </td>
              </tr>
            </tbody>
          </table>
          <!-- Said once, under the table, rather than repeated per row: what the
               marks mean and where the fix lives. Renders only when a month is
               actually marked, so a clean fleet never reads a caveat about a
               problem it does not have. -->
          <p v-if="fuelMonthsFlagged" class="cal-note fuel-mo-note">
            <!-- {{ ' ' }} is load-bearing: Vue's condense mode deletes a
                 whitespace-only text node containing a newline between two
                 elements, which glued "recorded." to the count that follows. -->
            <strong>$/Gal is spend divided by the gallons recorded.</strong>{{ ' ' }}
            <template v-if="volumelessTotals">
              {{ volumelessTotals.count }} fuel receipt{{ volumelessTotals.count === 1 ? '' : 's' }} on file
              ({{ fmtMoney(volumelessTotals.totalAmount) }}) carr{{ volumelessTotals.count === 1 ? 'ies' : 'y' }}
              a dollar amount and no volume,
            </template>
            <template v-else>Some receipts carry a dollar amount and no volume,</template>
            so in the {{ fuelMonthsFlagged === 1 ? 'month' : 'months' }} marked
            <em>partial</em> the denominator is short and the true price is <em>lower</em> than shown —
            which is why those read “at most”. A month showing <em>—</em> has no recorded volume at all
            to divide by. Both come from the
            <strong>Receipts missing gallons</strong> queue above; clearing it is what makes these figures
            exact.
          </p>
        </div>

        <!-- Recent fills. The Odo column carries its own provenance: only 2 of
             130 receipts in this fleet ever had an odometer written on them (and
             both were junk), so almost everything in this column is now filled
             from the ELD at the moment of the fill. A derived number must never
             read as if it were on the paper — hence the chip, and hence NO chip
             at all when the server didn't say where the value came from. -->
        <div v-if="!reviewFocus && fillRows.length" class="section-card">
          <div class="section-title">Recent Fuel Fills</div>
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Driver</th>
                <th>Amount</th>
                <th>Gal</th>
                <th title="Odometer at the fill. Tagged with where the reading came from — the receipt, or the truck's ELD.">Odo</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="f in fillRows" :key="f.id">
                <!-- fmtYmd, not the raw cell: the two review tables directly
                     above render "Jul 30, 2026" and two date formats one under
                     the other on one panel reads as two different kinds of
                     date. String arithmetic only — no Date(), so no day shift. -->
                <td class="mono">{{ fmtYmd(f.date) }}</td>
                <td>{{ f.driver }}</td>
                <td>${{ f.amount }}</td>
                <td>{{ f.gallons || '—' }}</td>
                <td class="mono odo-cell">
                  <template v-if="f.odoText !== '—'">
                    <span :class="['odo-value', { 'odo-derived': f.odoSrc && f.odoSrc.key === 'telemetry', 'odo-suspect': f.odoSuspect }]">{{ f.odoText }}</span>
                    <span
                      v-if="f.odoSrc"
                      :class="['odo-src', 'odo-src-' + f.odoSrc.key]"
                      :title="f.odoSrc.title"
                    >{{ f.odoSrc.label }}</span>
                    <span v-if="f.odoSuspect" class="odo-src odo-src-suspect" title="Unusually low for a tractor — worth confirming against the truck's real reading.">check</span>
                  </template>
                  <span v-else>—</span>
                </td>
              </tr>
            </tbody>
          </table>
          <p v-if="anyOdoSource" class="odo-legend">
            <span class="odo-src odo-src-receipt">receipt</span> the reading the driver wrote on the receipt
            &middot;
            <span class="odo-src odo-src-telemetry">ELD</span> the truck's own odometer at the moment its tank rose &mdash; derived, not on the paper
          </p>
        </div>

        <div v-if="!reviewFocus && !fillRows.length" class="empty-msg">
          No fuel data yet. Drivers log fuel expenses in their app.
        </div>
      </template>
    </div>

    <!-- ANALYTICS (Expense Intelligence) — v-if (not v-show) so the panel only
         fetches when opened; driver/truck lists are reused from this tab so the
         panel doesn't refetch them. -->
    <div v-if="activeSubTab === 'analytics'" class="sub-panel">
      <ExpenseAnalyticsPanel
        ref="analyticsPanel"
        :driver-options="allDrivers"
        :truck-options="truckList"
      />
    </div>

    <!-- MAINTENANCE SINKING FUND (Super Admin only) -->
    <div v-show="activeSubTab === 'maintenance' && auth.isSuperAdmin" class="sub-panel">
      <template v-if="maintLoading">
        <div class="skeleton skeleton-card"></div>
      </template>
      <template v-else>
        <div class="metrics-grid">
          <div class="metric-card accent">
            <div class="metric-label">Fund Balance</div>
            <div class="metric-value">${{ maint.balance?.toLocaleString() || 0 }}</div>
          </div>
          <div class="metric-card">
            <div class="metric-label">Monthly Target</div>
            <div class="metric-value">${{ maint.monthlyTarget?.toLocaleString() || 800 }}/mo</div>
          </div>
          <div class="metric-card">
            <div class="metric-label">Total Contributed</div>
            <div class="metric-value">${{ maint.totalContributed?.toLocaleString() || 0 }}</div>
          </div>
          <div class="metric-card">
            <div class="metric-label">Total Spent (PM)</div>
            <div class="metric-value">${{ maint.totalSpent?.toLocaleString() || 0 }}</div>
          </div>
        </div>

        <!-- Add entry form -->
        <div class="section-card">
          <div class="section-title">Log Entry</div>
          <div class="inline-form">
            <select v-model="maintForm.type" class="form-select">
              <option value="contribution">Contribution</option>
              <option value="service">PM Service</option>
            </select>
            <input v-model="maintForm.amount" type="number" step="0.01" min="0" placeholder="Amount" class="form-input" />
            <input v-model="maintForm.truck" type="text" placeholder="Truck" class="form-input sm" />
            <input v-model="maintForm.date" type="date" class="form-input" />
            <input v-model="maintForm.description" type="text" placeholder="Description" class="form-input wide" />
            <button class="btn btn-primary" :disabled="maintSubmitting" @click="submitMaintEntry">Add</button>
          </div>
        </div>

        <!-- History -->
        <div v-if="maint.entries?.length" class="section-card">
          <div class="section-title">Fund History</div>
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Type</th>
                <th>Amount</th>
                <th>Truck</th>
                <th>Description</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="e in maint.entries" :key="e.id">
                <td class="mono">{{ e.date }}</td>
                <td>
                  <span :class="['type-badge', e.type]">
                    {{ e.type === 'contribution' ? 'Deposit' : 'PM Service' }}
                  </span>
                </td>
                <td :class="e.type === 'service' ? 'text-danger' : 'text-accent'">
                  {{ e.type === 'service' ? '-' : '+' }}${{ e.amount }}
                </td>
                <td>{{ e.truck || '—' }}</td>
                <td class="desc-cell">{{ e.description || '—' }}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div v-if="!maint.entries?.length" class="empty-msg">
          No maintenance fund entries yet. Use the form above to log contributions and PM services.
        </div>
      </template>
    </div>

    <!-- IFTA / COMPLIANCE (Super Admin only) -->
    <div v-show="activeSubTab === 'ifta' && auth.isSuperAdmin" class="sub-panel">
      <template v-if="iftaLoading">
        <div class="skeleton skeleton-card"></div>
      </template>
      <template v-else>
        <!-- Date filter -->
        <div class="section-card">
          <div class="inline-form">
            <label class="filter-label">From
              <input v-model="iftaStart" type="date" class="form-input" />
            </label>
            <label class="filter-label">To
              <input v-model="iftaEnd" type="date" class="form-input" />
            </label>
            <button class="btn btn-primary" :disabled="iftaLoading" @click="loadIfta">Apply</button>
          </div>
        </div>

        <!-- IFTA Mileage -->
        <div class="metrics-grid">
          <div class="metric-card">
            <div class="metric-label">Total Miles (ELD)</div>
            <div class="metric-value">{{ ifta.totalMiles?.toLocaleString() || 0 }}</div>
          </div>
          <div class="metric-card">
            <div class="metric-label">States Tracked</div>
            <div class="metric-value">{{ iftaStatesTracked }}</div>
          </div>
          <div class="metric-card">
            <div class="metric-label">Trucks Tracked</div>
            <div class="metric-value">{{ ifta.truckCount || 0 }}</div>
          </div>
          <div class="metric-card">
            <div class="metric-label">Fees Pending</div>
            <div class="metric-value">${{ fees.totalDue?.toLocaleString() || 0 }}</div>
          </div>
        </div>

        <!-- Per-truck breakdown -->
        <div v-for="t in ifta.trucks" :key="t.truckId" class="section-card">
          <div class="truck-header">
            <div class="truck-title">{{ t.unitNumber || ('Truck #' + t.truckId) }}</div>
            <div class="truck-sub">
              Driver: {{ t.drivers.length ? t.drivers.join(', ') : '—' }}
              · {{ t.totalMiles.toLocaleString() }} mi
              · {{ t.states.length }} states
            </div>
          </div>
          <table v-if="t.states.length">
            <thead>
              <tr>
                <th>State</th>
                <th>Miles</th>
                <th>%</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="s in t.states"
                :key="s.state"
                class="state-row row-activatable"
                tabindex="0"
                :aria-label="`Open the day-by-day ${s.state} mileage for ${t.unitNumber || ('Truck #' + t.truckId)}`"
                @click="openStateDetail(t, s)"
                @keydown="rowKeyActivate($event, () => openStateDetail(t, s))"
              >
                <td class="mono bold">{{ s.state }}</td>
                <td>{{ s.miles.toLocaleString() }}</td>
                <td>{{ s.pct }}%</td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- State daily breakdown modal -->
        <div v-if="stateDetail" class="exp-overlay" @click.self="closeStateDetail">
          <div class="exp-dialog">
            <div class="exp-header">
              <div>
                <div class="exp-type">{{ stateDetail.state }}</div>
                <div class="exp-amount">{{ (stateDetail.totalMiles || 0).toLocaleString() }} mi</div>
                <div class="exp-sub">{{ stateDetail.unitNumber || ('Truck #' + stateDetail.truckId) }}</div>
              </div>
              <button class="exp-close" @click="closeStateDetail" aria-label="Close">&times;</button>
            </div>
            <div v-if="stateDetail.loading" class="skeleton skeleton-card"></div>
            <table v-else-if="stateDetail.days && stateDetail.days.length">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Miles</th>
                  <th>First ping</th>
                  <th>Last ping</th>
                  <th>Load(s)</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="d in stateDetail.days" :key="d.date">
                  <td class="mono">{{ d.date }}</td>
                  <td>{{ d.miles.toLocaleString() }}</td>
                  <td class="mono">{{ fmtHM(d.firstPing) }}</td>
                  <td class="mono">{{ fmtHM(d.lastPing) }}</td>
                  <td class="mono-sm">{{ d.loadIds && d.loadIds.length ? d.loadIds.join(', ') : '—' }}</td>
                </tr>
              </tbody>
            </table>
            <div v-else class="empty-msg">No telemetry recorded in this window.</div>
          </div>
        </div>

        <div v-if="!ifta.trucks?.length" class="empty-msg">
          No ELD mileage in this window. Try widening the date range, or link a truck to its Routemate vehicle on the Trucks page.
        </div>

        <!-- Compliance Fees -->
        <div class="section-card">
          <div class="section-title">Government Fees (2290 / Registration / IFTA)</div>
          <div class="inline-form">
            <select v-model="feeForm.type" class="form-select">
              <option value="2290">2290 (HVUT)</option>
              <option value="Registration">Registration</option>
              <option value="IFTA">IFTA Quarterly</option>
              <option value="IRP">IRP</option>
              <option value="Other">Other</option>
            </select>
            <input v-model="feeForm.amount" type="number" step="0.01" min="0" placeholder="Amount" class="form-input" />
            <input v-model="feeForm.truck" type="text" placeholder="Truck" class="form-input sm" />
            <input v-model="feeForm.dueDate" type="date" class="form-input" />
            <input v-model="feeForm.description" type="text" placeholder="Description" class="form-input wide" />
            <button class="btn btn-primary" :disabled="feeSubmitting" @click="submitFee">Add</button>
          </div>
        </div>

        <div v-if="fees.fees?.length" class="section-card">
          <div class="section-title">Fee Schedule</div>
          <table>
            <thead>
              <tr>
                <th>Type</th>
                <th>Amount</th>
                <th>Truck</th>
                <th>Due Date</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="f in fees.fees" :key="f.id">
                <td><span class="type-badge fee">{{ f.type }}</span></td>
                <td>${{ f.amount }}</td>
                <td>{{ f.truck || '—' }}</td>
                <td class="mono">{{ f.dueDate }}</td>
                <td>
                  <span :class="['status-pill', f.status.toLowerCase()]">{{ f.status }}</span>
                </td>
                <td>
                  <button
                    v-if="f.status === 'Pending'"
                    class="btn btn-sm"
                    @click="markFeePaid(f.id)"
                  >Mark Paid</button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted, onBeforeUnmount, watch } from 'vue'
import { usePagination } from '../../composables/usePagination'
import PaginationBar from '../shared/PaginationBar.vue'
import { useApi } from '../../composables/useApi'
import { useToast } from '../../composables/useToast'
import { useDocumentScan } from '../../composables/useDocumentScan'
import { useAuthStore } from '../../stores/auth'
import { useViewport } from '../../composables/useViewport'
import { useSocketRefresh } from '../../composables/useSocketRefresh'
import ZoomableImage from '../shared/ZoomableImage.vue'
import ExpenseAnalyticsPanel from './expenses/ExpenseAnalyticsPanel.vue'
import BulkReceiptScan from './expenses/BulkReceiptScan.vue'
import { US_STATES } from '../../utils/usStates'
import { compressImage } from '../../lib/imageUtils'
import { fmtTimestamp, fmtYmd, houstonToday, parseYmdLocal } from '../../utils/datetime'
import {
  fmtOdometer, odometerSource, isSuspectOdometer, asList,
  isReviewAvailable, isQueueAvailable, reviewClearPhrases, queueCounts,
  unmatchedFills, unmatchedReceipts, volumelessReceipts, volumelessSummary,
  odometerConflicts,
  tankCalibration, countCalibrationChecks, calibrationVerdict, anyBimodal,
} from '../../lib/fuelReview'

const api = useApi()
const { show: toast } = useToast()
const { scanDocument } = useDocumentScan()
const auth = useAuthStore()
const { isMobile } = useViewport()

const allSubTabs = [
  { key: 'all', label: 'All Expenses' },
  // Bulk receipt upload — Super Admin + Dispatcher (both reach this route and
  // can log expenses). No adminOnly flag so Dispatchers see it too.
  { key: 'bulk', label: 'Bulk Upload' },
  { key: 'fuel', label: 'Fuel Logs' },
  // No adminOnly flag: Analytics is visible to Super Admin AND Dispatcher.
  { key: 'analytics', label: 'Analytics' },
  { key: 'maintenance', label: 'Maintenance Fund', adminOnly: true },
  { key: 'ifta', label: 'IFTA / Compliance', adminOnly: true },
]

const subTabs = computed(() =>
  allSubTabs.filter(t => !t.adminOnly || auth.isSuperAdmin)
)

const activeSubTab = ref('all')

// All expenses
const allExpenses = ref([])
// Client-side pagination for the expenses list — render one page of rows at a
// time (default 25) instead of all rows at once. Server-side filtering already
// scopes `allExpenses`; this only pages the render (and limits how many receipt
// thumbnails are in the DOM at once). Bar auto-hides at ≤1 page.
const { page, pageSize, totalPages, paginatedItems, goTo, setSize } = usePagination(allExpenses, 25)
// A socket refresh (quietReload) can shrink the list — keep the page in range
// without yanking the admin back to page 1 the way a filter change does.
watch(totalPages, (tp) => { if (page.value > tp) goTo(tp) })
const allLoading = ref(true)
const allDrivers = ref([])
const previewImg = ref(null)

// Hover-to-zoom for the list receipt thumbnails: a floating full-size preview
// appears beside the hovered row (no click). Anchored to the thumbnail and
// clamped to the viewport; clicking still opens the full zoomable lightbox.
const hoverReceipt = ref(null) // { src, top, left, w, maxH }
function showReceiptPreview(exp, evt) {
  if (!exp || !exp.photo_data || isPdfReceipt(exp.photo_data)) return
  const r = evt.currentTarget.getBoundingClientRect()
  const w = 340
  let left = r.left - w - 14 // prefer the left of the thumb (thumbs sit near the right edge)
  if (left < 8) left = Math.min(r.right + 14, window.innerWidth - w - 8)
  let top = Math.max(8, r.top - 20)
  let maxH = window.innerHeight - top - 12
  if (maxH < 260) { maxH = Math.min(560, window.innerHeight - 16); top = Math.max(8, window.innerHeight - maxH - 12) }
  hoverReceipt.value = { src: exp.photo_data, top, left, w, maxH }
}
function hideReceiptPreview() { hoverReceipt.value = null }
// Detail modal: track by expense id, not array index — robust if the list
// refetches (socket event from another tab) while the modal is open. null
// means closed.
const selectedId = ref(null)
const selectedExpense = computed(() =>
  selectedId.value == null
    ? null
    : (allExpenses.value.find(e => e.id === selectedId.value) ?? null)
)
const selectedIndex = computed(() =>
  selectedId.value == null
    ? -1
    : allExpenses.value.findIndex(e => e.id === selectedId.value)
)
// Indices in allExpenses whose status is Pending — Prev/Next walks this
// list (not the raw array) so admin only cycles through pending approvals,
// matching the CEO's wording.
const pendingIndices = computed(() => {
  const out = []
  const list = allExpenses.value
  for (let i = 0; i < list.length; i++) {
    if ((list[i].status || 'Pending') === 'Pending') out.push(i)
  }
  return out
})
const isCurrentPending = computed(() =>
  selectedExpense.value && (selectedExpense.value.status || 'Pending') === 'Pending'
)
const pendingPos = computed(() => {
  const idx = selectedIndex.value
  if (idx < 0) return -1
  return pendingIndices.value.indexOf(idx)
})
const canGoPrev = computed(() => {
  const idx = selectedIndex.value
  const pis = pendingIndices.value
  if (idx < 0 || pis.length === 0) return false
  return pis[0] < idx
})
const canGoNext = computed(() => {
  const idx = selectedIndex.value
  const pis = pendingIndices.value
  if (idx < 0 || pis.length === 0) return false
  return pis[pis.length - 1] > idx
})
const approveLoading = ref(false)

// Inline city/state edit inside the detail modal. Reset whenever the modal
// opens / closes / navigates (see the selectedExpense watch below).
const editingLocation = ref(false)
const savingLocation = ref(false)
const locDraft = reactive({ city: '', state: '' })

// Inline vendor edit — same lifecycle as the city/state editor above.
const editingVendor = ref(false)
const savingVendor = ref(false)
const vendorDraft = ref('')

function openExpenseDetail(e) {
  selectedId.value = e.id
}
function closeExpenseDetail() {
  selectedId.value = null
}
function goPrev() {
  if (!canGoPrev.value) return
  const idx = selectedIndex.value
  const pis = pendingIndices.value
  for (let i = pis.length - 1; i >= 0; i--) {
    if (pis[i] < idx) {
      selectedId.value = allExpenses.value[pis[i]].id
      return
    }
  }
}
function goNext() {
  if (!canGoNext.value) return
  const idx = selectedIndex.value
  const pis = pendingIndices.value
  for (let i = 0; i < pis.length; i++) {
    if (pis[i] > idx) {
      selectedId.value = allExpenses.value[pis[i]].id
      return
    }
  }
}
// After Approve/Reject, hop to the next Pending row so the admin can clear
// the queue in one sitting. Forward first, then wrap to the start of the
// list. If literally no Pending row exists anywhere, stay on the current
// row — the modal does NOT auto-close, the counter just reads "0 pending
// remain" and the action buttons flip to Undo.
function advanceToNextPending() {
  const list = allExpenses.value
  const idx = selectedIndex.value
  if (idx < 0) return
  for (let i = idx + 1; i < list.length; i++) {
    if ((list[i].status || 'Pending') === 'Pending') {
      selectedId.value = list[i].id
      return
    }
  }
  for (let i = 0; i < idx; i++) {
    if ((list[i].status || 'Pending') === 'Pending') {
      selectedId.value = list[i].id
      return
    }
  }
  // No other pending found — stay on the just-approved row.
}
async function approveCurrent() {
  const exp = selectedExpense.value
  if (!exp || approveLoading.value) return
  approveLoading.value = true
  try {
    await setStatus(exp.id, 'Approved')
    advanceToNextPending()
  } catch { /* setStatus already toasted */ }
  finally { approveLoading.value = false }
}
async function rejectCurrent() {
  const exp = selectedExpense.value
  if (!exp || approveLoading.value) return
  approveLoading.value = true
  try {
    await setStatus(exp.id, 'Rejected')
    advanceToNextPending()
  } catch { /* setStatus already toasted */ }
  finally { approveLoading.value = false }
}
async function undoCurrent() {
  const exp = selectedExpense.value
  if (!exp || approveLoading.value) return
  approveLoading.value = true
  try {
    await setStatus(exp.id, 'Pending')
  } catch { /* setStatus already toasted */ }
  finally { approveLoading.value = false }
}
function isFuelExpense(e) {
  return e && (e.type || '').toLowerCase() === 'fuel' && Number(e.gallons) > 0
}
function pricePerGallon(e) {
  const amt = Number(e.amount) || 0
  const g = Number(e.gallons) || 0
  if (g <= 0) return '\u2014'
  return (amt / g).toFixed(3)
}
const expenseTypes = ['Fuel', 'Repair', 'Maintenance', 'Wear & Tear', 'Toll', 'Food', 'Other']
// Receipt dates far from today are almost always a misread year — a handwritten
// year that ran off the page, or a store printer with a wrong clock. Both have
// dropped real expenses out of the month they belonged to.
const ADD_DATE_STALE_DAYS = 120
const addDateSuspect = computed(() => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(addForm.date || '')
  if (!m) return ''
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  if (isNaN(d)) return ''
  const days = (Date.now() - d.getTime()) / 86400000
  if (days < -1) return 'This is dated in the future — check the date.'
  if (days <= ADD_DATE_STALE_DAYS) return ''
  return Number(m[1]) === new Date().getFullYear()
    ? 'This is over 4 months old — check the date.'
    : `This is dated ${m[1]} — check the year before saving.`
})
// "2026-06" -> "June 2026", for telling the filer which month a receipt was
// booked to when its own month is already closed.
function monthLabel(period) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(period || ''))
  if (!m) return period || ''
  return new Date(Number(m[1]), Number(m[2]) - 1, 1)
    .toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
}
const allFilter = reactive({ driver: '', type: '', status: '', truck: '', state: '', from: '', to: '' })
// Text search across vendor/description/city — debounced 300ms so we don't
// refetch per keystroke.
const allQ = ref('')
let allQTimer = null
watch(allQ, () => {
  clearTimeout(allQTimer)
  allQTimer = setTimeout(loadAll, 300)
})

// Analytics sub-tab panel (v-if mounted) — exposes reload() for the
// expenses:changed socket handler below.
const analyticsPanel = ref(null)

// Keyboard nav for the detail modal. Listener attaches only while the modal is
// open so we don't leak global handlers. The receipt now zooms INLINE in the
// modal (no separate lightbox opens from here), so there's nothing to defer
// Escape to — arrows navigate, Escape closes the modal.
function onModalKeydown(ev) {
  if (ev.key === 'ArrowLeft') { ev.preventDefault(); goPrev() }
  else if (ev.key === 'ArrowRight') { ev.preventDefault(); goNext() }
  else if (ev.key === 'Escape') { ev.preventDefault(); closeExpenseDetail() }
}
watch(selectedExpense, (cur, prev) => {
  if (cur && !prev) window.addEventListener('keydown', onModalKeydown)
  else if (!cur && prev) window.removeEventListener('keydown', onModalKeydown)
  // Drop edit mode on open/close/navigate so a stale draft never leaks across rows.
  editingLocation.value = false
  editingVendor.value = false
})

function startEditLocation() {
  const e = selectedExpense.value
  locDraft.city = e?.location_city || ''
  locDraft.state = e?.location_state || ''
  editingLocation.value = true
}
async function saveLocation() {
  const e = selectedExpense.value
  if (!e || savingLocation.value) return
  savingLocation.value = true
  try {
    const city = locDraft.city.trim()
    const state = locDraft.state.trim().toUpperCase()
    await api.patch(`/api/expenses/${e.id}/location`, { city, state })
    // Reflect on the live row so the table + modal update immediately.
    const row = allExpenses.value.find(x => x.id === e.id)
    if (row) { row.location_city = city; row.location_state = state }
    toast('Location updated', 'success')
    editingLocation.value = false
  } catch (err) {
    toast(err?.message || 'Failed to update location', 'error')
  } finally {
    savingLocation.value = false
  }
}

function startEditVendor() {
  vendorDraft.value = selectedExpense.value?.vendor || ''
  editingVendor.value = true
}
async function saveVendor() {
  const e = selectedExpense.value
  if (!e || savingVendor.value) return
  savingVendor.value = true
  try {
    const vendor = vendorDraft.value.trim()
    const res = await api.patch(`/api/expenses/${e.id}/vendor`, { vendor })
    // Reflect on the live row so the table + modal update immediately. The
    // server echoes the canonical vendor + normalized key back.
    const row = allExpenses.value.find(x => x.id === e.id)
    if (row) {
      row.vendor = res?.vendor ?? vendor
      row.vendor_normalized = res?.vendorNormalized ?? row.vendor_normalized
    }
    toast('Vendor updated', 'success')
    editingVendor.value = false
  } catch (err) {
    toast(err?.message || 'Failed to update vendor', 'error')
  } finally {
    savingVendor.value = false
  }
}

// Receipt Details — run Gemini OCR on the ALREADY-stored receipt and surface
// the parsed label/value pairs. The endpoint persists them server-side; we also
// patch the row in `allExpenses` so the modal (a computed-by-id) re-renders
// live — the same pattern saveVendor/saveLocation use. Only image receipts can
// be extracted (the server 415s on PDFs).
const extractingDetails = ref(false)
const canExtractDetails = computed(() => {
  const e = selectedExpense.value
  return !!(e && e.photo_data && !isPdfReceipt(e.photo_data))
})
async function extractReceiptDetails() {
  const e = selectedExpense.value
  if (!e || extractingDetails.value) return
  extractingDetails.value = true
  try {
    const res = await api.post(`/api/expenses/${e.id}/extract-details`)
    const details = Array.isArray(res?.receipt_details) ? res.receipt_details : []
    const row = allExpenses.value.find(x => x.id === e.id)
    if (row) row.receipt_details = details
    toast(details.length ? 'Receipt details extracted' : 'No details found on this receipt', 'success')
  } catch (err) {
    if (err?.status === 415) toast("PDF receipts can't be auto-extracted", 'error')
    else if (err?.status === 503) toast("Receipt scanning isn't configured", 'error')
    else toast(err?.message || 'Failed to extract receipt details', 'error')
  } finally {
    extractingDetails.value = false
  }
}
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onModalKeydown)
  clearTimeout(allQTimer)
})

// Add Expense form (Super Admin / Dispatcher only)
const canAddExpense = computed(() => auth.isSuperAdmin || auth.user?.role === 'Dispatcher')
// Default date uses local getters, NOT toISOString(): the latter yields the UTC
// day, so after 7pm Houston it would pre-fill tomorrow — and at month end that
// books the receipt into the wrong period entirely. Mirrors ExpenseForm.vue.
const addForm = reactive({ driver: '', type: 'Fuel', amount: '', date: houstonToday(), loadId: '', description: '', city: '', state: '', gallons: '', odometer: '' })
const addLoading = ref(false)
const fileInputRef = ref(null)
// photoBase64 holds the receipt as a data URI — image/jpeg from the canvas
// pipeline, or application/pdf straight from FileReader (admin/dispatcher
// PDF support, 2026-06-11 owner meeting). The server branches on the MIME.
const photoBase64 = ref('')
const photoProcessing = ref(false)
const pdfName = ref('')
const photoIsPdf = computed(() => photoBase64.value.startsWith('data:application/pdf'))
const MAX_PDF_FILE_BYTES = 15 * 1024 * 1024 // matches the server-side create cap
// POST /api/expenses/ocr rejects a photoData string over 8,500,000 chars (413).
// A downscaled photo is never close; a PDF is sent as-is, so it can be. Checked
// before the call so an oversize PDF still ATTACHES (up to the 15 MB create cap)
// and only loses the auto-fill, instead of eating a 413.
const MAX_OCR_PAYLOAD_CHARS = 8500000
const MAX_OCR_PAYLOAD_LABEL = '6 MB'

// Receipt OCR autofill on the single Log Expense form — mirrors the driver
// ExpenseForm. After a photo is enhanced, Gemini reads it and prefills the
// fields; the admin confirms/edits before Add. Undo restores what was typed.
// (No separate ocrLoading spinner — the OCR round-trip runs inside the existing
// photoProcessing "Processing file…" state, so that hint already covers it.)
const ocrApplied = ref(false)
const ocrConfidence = ref('')
// OCR-extracted dynamic receipt fields, carried through to POST /api/expenses so
// a newly-logged receipt stores its details without the on-demand "Extract".
const ocrDetails = ref([])
const preOcrSnapshot = ref(null)

// Download Receipts (Super Admin only) — ZIP bundle endpoint
const truckList = ref([])
// Computed so a long-lived tab that crosses midnight still clamps correctly.
// en-CA gives the LOCAL day; toISOString() gives the UTC one, which after 7pm
// Houston would let the user pick tomorrow.
const todayIso = computed(() => houstonToday())
const downloadForm = reactive({ truck: '', from: '', to: '' })
const downloadLoading = ref(false)
const downloadError = ref('')
const canDownload = computed(() =>
  downloadForm.truck && downloadForm.from && downloadForm.to && downloadForm.to >= downloadForm.from
)

async function loadTruckList() {
  try {
    const res = await api.get('/api/trucks')
    const rows = res.data || res.trucks || res || []
    const units = rows.map(t => t.UnitNumber || t.unit_number || t.unit).filter(Boolean)
    truckList.value = [...new Set(units)].sort()
  } catch (err) {
    console.error('loadTruckList failed:', err)
    if (auth.isSuperAdmin) downloadError.value = 'Could not load truck list. Refresh to retry.'
  }
}

async function downloadReceipts() {
  downloadError.value = ''
  if (!canDownload.value) {
    downloadError.value = 'Pick a truck and a valid date range first.'
    return
  }
  downloadLoading.value = true
  try {
    // HEAD-style probe via fetch so we can surface JSON errors (404/400)
    // to the user instead of a broken file download.
    const qs = new URLSearchParams({
      truck: downloadForm.truck,
      from: downloadForm.from,
      to: downloadForm.to,
    }).toString()
    const url = `/api/expenses/receipts-download?${qs}`
    const res = await fetch(url, { credentials: 'include' })
    if (!res.ok) {
      let msg = `Download failed (${res.status})`
      try { const j = await res.json(); if (j?.error) msg = j.error } catch { /* not JSON */ }
      downloadError.value = msg
      return
    }
    const blob = await res.blob()
    const filename = `${downloadForm.truck}-receipts-${downloadForm.from}-to-${downloadForm.to}.zip`
    const link = document.createElement('a')
    link.href = URL.createObjectURL(blob)
    link.download = filename
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(link.href)
    toast('Receipt bundle downloaded', 'success')
  } catch (err) {
    downloadError.value = err?.message || 'Failed to download receipts'
  } finally {
    downloadLoading.value = false
  }
}

function isPdfFile(file) {
  // Some browsers report an empty MIME for .pdf files picked from odd
  // sources — fall back to the extension.
  return file.type === 'application/pdf' || /\.pdf$/i.test(file.name || '')
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = () => reject(reader.error || new Error('File read failed'))
    reader.readAsDataURL(file)
  })
}

// PDFs skip the IMAGE pipeline (canvas downscale + ScanKit enhance — neither can
// rasterize a document) but they DO get read: Gemini takes the PDF bytes on the
// same OCR endpoint a photo uses, so a PDF toll invoice auto-fills the form just
// like a photographed receipt.
async function handlePdfInput(blob) {
  if (blob.size > MAX_PDF_FILE_BYTES) {
    if (fileInputRef.value) fileInputRef.value.value = ''
    toast('PDF is too large — 15 MB max', 'error')
    return
  }
  photoProcessing.value = true
  try {
    const dataUrl = await readFileAsDataUrl(blob)
    // Normalize the prefix so the server's application/pdf branch always
    // matches even when the browser left the MIME blank.
    photoBase64.value = String(dataUrl).replace(/^data:[^;]*;base64,/, 'data:application/pdf;base64,')
    pdfName.value = blob.name || 'receipt.pdf'
    await runAddFormOcr()
  } catch {
    photoBase64.value = ''
    pdfName.value = ''
    if (fileInputRef.value) fileInputRef.value.value = ''
    toast("Couldn't read the PDF — try a different file", 'error')
  } finally {
    photoProcessing.value = false
  }
}

async function handleFileInput(event) {
  const blob = event.target.files && event.target.files[0]
  if (!blob) return
  // New file selected → drop any OCR state from a prior receipt before branching,
  // so swapping one receipt for another can't carry stale details or the
  // "✓ Autofilled" chip onto the new file. Both branches re-run runAddFormOcr.
  ocrApplied.value = false
  ocrConfidence.value = ''
  ocrDetails.value = []
  preOcrSnapshot.value = null
  if (isPdfFile(blob)) {
    await handlePdfInput(blob)
    return
  }
  pdfName.value = ''
  photoProcessing.value = true
  try {
    // Shared helper: one-pass createImageBitmap downscale (OOM defense — a 12MP
    // photo never materializes ~48MB of raw RGBA) that also converts iPhone
    // HEIC→JPEG so Chrome/Android admins aren't stuck with a blank preview.
    photoBase64.value = await compressImage(blob, 1024)
    if (!photoBase64.value) throw new Error('unreadable')
    // compressImage only yields a canvas JPEG on a real decode; a non-JPEG data
    // URL means the format couldn't be decoded/converted (e.g. a HEIC even
    // heic2any couldn't handle). Don't store an unviewable receipt or waste a
    // doomed enhance/OCR round-trip — tell the admin to convert it. Mirrors the
    // Bulk grid's ocrable gate.
    if (!/^data:image\/(jpeg|jpg|png|webp);base64,/i.test(photoBase64.value)) {
      photoBase64.value = ''
      if (fileInputRef.value) fileInputRef.value.value = ''
      toast("Couldn't read this photo — convert HEIC to JPEG and try again", 'error')
      return
    }
    // Enhance the receipt via ScanKit (crop + flatten lighting) for a cleaner
    // stored image, then OCR it to prefill the form. Both best-effort — any
    // failure keeps the raw photo and leaves manual entry intact.
    await enhanceReceiptPhoto()
    await runAddFormOcr()
  } catch {
    photoBase64.value = ''
    if (fileInputRef.value) fileInputRef.value.value = ''
    toast("Couldn't process the photo — try a different image", 'error')
  } finally {
    photoProcessing.value = false
  }
}

// Best-effort receipt enhancement via ScanKit. Swallows all errors so a
// disabled / uncredited / down service never blocks logging the expense.
async function enhanceReceiptPhoto() {
  if (!photoBase64.value) return
  try {
    const res = await scanDocument(photoBase64.value, { returnPdf: false, filter: 'flat' })
    if (res && res.data) photoBase64.value = res.data
  } catch {
    // Keep the raw photo.
  }
}

// Read the receipt with Gemini and prefill the Log Expense fields. Mirrors the
// driver form: only fills empty/default fields, snapshots first so Undo can
// restore, and stays silent when OCR is disabled (503) so manual entry is never
// blocked. Runs for images AND PDFs — a PDF just arrives here un-enhanced.
async function runAddFormOcr() {
  if (!photoBase64.value) return
  // Only a PDF can realistically exceed the endpoint's payload cap (photos are
  // downscaled first). Skip the doomed round-trip and say so — the receipt is
  // already attached, so only the auto-fill is lost.
  if (photoBase64.value.length > MAX_OCR_PAYLOAD_CHARS) {
    toast(`Receipt is too large to auto-read (${MAX_OCR_PAYLOAD_LABEL} max) — attached, enter the fields manually`, 'error')
    return
  }
  ocrApplied.value = false
  ocrConfidence.value = ''
  ocrDetails.value = []
  preOcrSnapshot.value = {
    type: addForm.type,
    amount: addForm.amount,
    date: addForm.date,
    description: addForm.description,
    city: addForm.city,
    state: addForm.state,
  }
  try {
    const data = await api.post('/api/expenses/ocr', { photoData: photoBase64.value }, { timeout: 50000 })
    if (data.amount != null) addForm.amount = String(data.amount)
    if (data.date) addForm.date = data.date
    if (data.city != null) addForm.city = String(data.city)
    if (data.state != null) addForm.state = String(data.state).toUpperCase().slice(0, 2)
    // Only accept a type the select actually offers — assigning an unlisted value
    // (e.g. "Tolls" for "Toll") silently blanks this REQUIRED field, so the admin
    // sees an empty Type with no explanation. Bulk already guards this way.
    if (data.suggestedType && expenseTypes.includes(data.suggestedType) && addForm.type === 'Fuel') {
      addForm.type = data.suggestedType
    }
    // The OCR has always returned these; this form just never used them.
    if (data.gallons != null) addForm.gallons = String(data.gallons)
    if (data.odometer != null) addForm.odometer = String(data.odometer)
    // No dedicated vendor field on this form — fold the vendor into the
    // description only when the admin left it blank, so the info isn't lost.
    if (data.vendor && !addForm.description.trim()) addForm.description = String(data.vendor).slice(0, 80)
    ocrApplied.value = true
    ocrConfidence.value = data.confidence || ''
    ocrDetails.value = Array.isArray(data.details) ? data.details : []
  } catch (err) {
    // 503 = OCR key unset: silent manual-entry fallback. Anything else is a
    // soft failure — keep the photo, don't nag, admin fills the fields.
    if (err?.status !== 503) toast('Couldn\'t read the receipt — enter the fields manually', 'error')
    preOcrSnapshot.value = null
  }
}

function undoAddAutofill() {
  if (!preOcrSnapshot.value) return
  addForm.type = preOcrSnapshot.value.type
  addForm.amount = preOcrSnapshot.value.amount
  addForm.date = preOcrSnapshot.value.date
  addForm.description = preOcrSnapshot.value.description
  addForm.city = preOcrSnapshot.value.city
  addForm.state = preOcrSnapshot.value.state
  ocrApplied.value = false
  ocrDetails.value = []
}

// Bulk upload saved ≥1 expense — refresh the underlying list in the background
// so the "All Expenses" tab is current, without yanking the admin off the bulk
// tab (failed/unfixed rows stay visible there).
async function onBulkSaved() {
  await loadAll()
}

function clearPhoto() {
  photoBase64.value = ''
  pdfName.value = ''
  if (fileInputRef.value) fileInputRef.value.value = ''
  ocrApplied.value = false
  ocrConfidence.value = ''
  ocrDetails.value = []
  preOcrSnapshot.value = null
}

async function submitExpense() {
  if (!addForm.driver || !addForm.type || !addForm.amount || !addForm.date) {
    toast('Fill in Driver, Type, Amount, and Date', 'error'); return
  }
  const parsedAmt = parseFloat(addForm.amount)
  if (isNaN(parsedAmt) || parsedAmt <= 0) {
    toast('Amount must be greater than zero', 'error'); return
  }
  addLoading.value = true
  try {
    const payload = {
      driver: addForm.driver,
      type: addForm.type,
      amount: parseFloat(addForm.amount),
      date: addForm.date,
      loadId: addForm.loadId || '',
      description: addForm.description || '',
      city: addForm.city || '',
      state: addForm.state || '',
      photoData: photoBase64.value,
      // Were hardcoded to 0, so every admin-entered fuel receipt lost its gallons
      // and dropped out of cost-per-gallon / MPG. The OCR already returns both.
      gallons: parseFloat(addForm.gallons) || 0,
      odometer: parseFloat(addForm.odometer) || 0,
      receiptDetails: ocrDetails.value,
      // Opt in to the same-driver/merchant/day/amount check — this form can
      // confirm and resend, so a 409 here is always survivable.
      checkDuplicate: true,
    }
    let res
    try {
      res = await api.post('/api/expenses', payload)
    } catch (err) {
      // The server flags same-merchant/day/amount as a POSSIBLE duplicate. It is
      // a warning, not a verdict — a driver can genuinely fuel twice at one stop —
      // so confirm and resend rather than leaving the admin stuck with an error.
      if (err?.status === 409 && err?.code === 'POSSIBLE_DUPLICATE') {
        const ok = window.confirm(`${err.message}\n\nLog it anyway?`)
        if (!ok) { toast('Not logged — treated as a duplicate', 'info'); return }
        res = await api.post('/api/expenses', { ...payload, allowDuplicate: true })
      } else {
        throw err
      }
    }
    // Its own month is already closed, so it books to the current open month
    // instead. Say so — the expense is filed, just not where the date implies.
    if (res?.periodClosed && res?.postedPeriod) {
      toast(`Expense logged — ${monthLabel(res.naturalPeriod)} is closed, so it was booked to ${monthLabel(res.postedPeriod)}`, 'warning')
    } else {
      toast('Expense logged')
    }
    addForm.driver = ''; addForm.amount = ''; addForm.loadId = ''; addForm.description = ''; addForm.city = ''; addForm.state = ''
    addForm.gallons = ''; addForm.odometer = ''
    clearPhoto()
    await loadAll()
  } catch (err) {
    toast(err.message || 'Failed to log expense', 'error')
  } finally {
    addLoading.value = false
  }
}

// Shared query-string builder for /api/expenses/all — used by loadAll AND
// quietReload so a socket-driven refresh always respects the active filters.
function buildAllExpensesQuery() {
  const params = new URLSearchParams()
  if (allFilter.driver) params.set('driver', allFilter.driver)
  if (allFilter.type) params.set('type', allFilter.type)
  if (allFilter.status) params.set('status', allFilter.status)
  if (allFilter.truck) params.set('truck', allFilter.truck)
  if (allFilter.state) params.set('state', allFilter.state)
  if (allFilter.from) params.set('from', allFilter.from)
  if (allFilter.to) params.set('to', allFilter.to)
  if (allQ.value.trim()) params.set('q', allQ.value.trim())
  return params.toString() ? `?${params.toString()}` : ''
}

async function loadAll() {
  allLoading.value = true
  // Full reload = filters (or data set) changed — a carried-over selection
  // could silently target rows that are no longer on screen. The bulk-result
  // notice goes for the same reason: it says "the list below", and below is
  // about to become a different list.
  clearSelection()
  bulkOutcome.value = null
  goTo(1) // filters/data changed → jump back to the first page
  try {
    const data = await api.get(`/api/expenses/all${buildAllExpensesQuery()}`)
    allExpenses.value = data.expenses || []
    // Build driver list from drivers directory (not from expenses — new drivers with no expenses would be missing)
    if (allDrivers.value.length === 0) {
      try {
        const dd = await api.get('/api/drivers-directory')
        const names = (dd.data || []).map(d => d.Driver || d.driver_name).filter(Boolean)
        allDrivers.value = [...new Set(names)].sort()
      } catch {
        // Fallback: derive from existing expenses
        const names = new Set(allExpenses.value.map(e => e.driver).filter(Boolean))
        allDrivers.value = [...names].sort()
      }
    }
  } catch { /* empty */ }
  allLoading.value = false
}

// Socket-driven background refresh. Mirrors loadAll's data fetch but skips
// the allLoading skeleton flash — used when the server emits expenses:changed
// (own actions or another tab). The detail modal stays open because
// selectedExpense resolves by id against the freshly-swapped array.
async function quietReload() {
  try {
    const data = await api.get(`/api/expenses/all${buildAllExpensesQuery()}`)
    allExpenses.value = data.expenses || []
    pruneSelection()
  } catch { /* empty — leave existing data in place */ }
}

async function setStatus(id, status) {
  try {
    await api.put(`/api/expenses/${id}/status`, { status })
    const exp = allExpenses.value.find(e => e.id === id)
    if (exp) exp.status = status
    toast(status === 'Approved' ? 'Expense approved' : status === 'Rejected' ? 'Expense rejected' : 'Status reset', 'success')
  } catch (err) {
    toast('Failed to update status', 'error')
    throw err
  }
}

// ---- Multi-select + bulk approve (2026-06-11 owner meeting) ---------------
// selectedIds is always REPLACED with a new Set (never mutated in place) so
// every computed/template dep re-evaluates reliably.
const BULK_CHUNK = 200 // server caps ids per request \u2014 chunk larger selections
const selectedIds = ref(new Set())
const bulkLoading = ref(false)
const visiblePendingIds = computed(() =>
  allExpenses.value.filter(e => (e.status || 'Pending') === 'Pending').map(e => e.id)
)
const allVisiblePendingSelected = computed(() =>
  visiblePendingIds.value.length > 0 &&
  visiblePendingIds.value.every(id => selectedIds.value.has(id))
)
function toggleSelect(id) {
  const next = new Set(selectedIds.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  selectedIds.value = next
}
// Header checkbox targets Pending rows in the current filtered view (the
// "approve everything I'm looking at" flow). Unchecking clears the whole
// selection \u2014 including manually-ticked non-pending rows \u2014 so the bulk bar
// never lingers with hidden selections.
function toggleSelectAllPending() {
  selectedIds.value = allVisiblePendingSelected.value
    ? new Set()
    : new Set(visiblePendingIds.value)
}
function clearSelection() {
  selectedIds.value = new Set()
}
// Drop selected ids that no longer exist after a refetch (socket refresh or
// another admin deleting rows) so a bulk action never targets stale ids.
function pruneSelection() {
  if (selectedIds.value.size === 0) return
  const live = new Set(allExpenses.value.map(e => e.id))
  selectedIds.value = new Set([...selectedIds.value].filter(id => live.has(id)))
}
// The outcome of the last bulk action, kept ON SCREEN rather than in a toast.
//
// A toast is a 3-second animation (useToast clears at 3000ms). That is the right
// weight for "12 approved" and the wrong weight for "2 of your 12 were refused
// and are still Pending" \u2014 the second is a fact about the books that someone has
// to act on, and it must not expire while they are scrolling. Null whenever
// there is nothing to reconcile, so a clean run adds no chrome.
const bulkOutcome = ref(null)

// Bulk approve/reject, reconciled against what the server actually committed.
//
// The endpoint does NOT fail a mixed batch wholesale. It updates the rows whose
// month is open, withholds the rows whose month month-end close has finalized,
// and reports the split: `updated`, `skippedFinalized`, `finalizedPeriods` and a
// ready-made `message`. Every one of those was previously discarded \u2014 the old
// loop marked the WHOLE chunk with the new status and toasted "N approved", so
// receipts the server had refused rendered as approved and nothing named the
// closed month. On a healthy socket the `expenses:changed` refetch quietly
// corrected the rows ~300ms later, which is exactly what made this hard to
// notice; with the socket down (measured) the wrong status stayed until reload.
//
// The response says HOW MANY rows were withheld, never WHICH. That asymmetry is
// the design constraint here:
//   \u00b7 a chunk that committed in full can still be patched in place \u2014 the
//     optimistic write is provably right for every row in it;
//   \u00b7 a chunk that did not is re-read from the database rather than guessed at.
// Deriving the withheld rows client-side (matching each row's month against
// `finalizedPeriods`) was deliberately NOT done: `expenses.posted_period` books
// a receipt whose own month is closed into the current open one, so a row dated
// 2026-05-01 with posted_period 2026-08 is editable while its date says
// otherwise \u2014 a live example sits in this data. Guessing gets that row exactly
// backwards. lockState() in lib/fuelReview.js refuses the same derivation for
// the same reason: server-told only.
async function bulkSetStatus(status) {
  const ids = [...selectedIds.value]
  if (ids.length === 0 || bulkLoading.value) return
  bulkLoading.value = true
  bulkOutcome.value = null

  const verb = status === 'Approved' ? 'approved' : status === 'Rejected' ? 'rejected' : 'reset'
  let sent = 0
  let updated = 0
  let withheld = 0
  let missing = 0
  let lockUnreadable = false
  let needsReread = false
  let failure = ''
  const periods = new Set()

  try {
    for (let i = 0; i < ids.length; i += BULK_CHUNK) {
      const chunk = ids.slice(i, i + BULK_CHUNK)
      // Counted BEFORE the await, so `sent` is what was attempted rather than
      // what came back. A chunk that throws still belongs in the denominator —
      // otherwise a run that died half-way reports "3 of 3 approved" and the
      // two rows nobody touched vanish from the arithmetic.
      sent += chunk.length
      const resp = await api.put('/api/expenses/bulk-status', { ids: chunk, status })

      // `updated` ABSENT is not `updated: 0`. A server predating this field
      // answered 200 only when it had written everything, so falling back to the
      // chunk size preserves that server's meaning \u2014 the same absent-vs-empty
      // rule the review queues use. Reading absent as "nothing landed" would
      // report a completely successful run as a total failure.
      const committed = Number(resp?.updated)
      const reported = Number.isFinite(committed)
      updated += reported ? committed : chunk.length
      withheld += Number(resp?.skippedFinalized) || 0
      missing += Number(resp?.skipped) || 0
      // Only ever true when the server says so. `finalizedPeriods` is [] in this
      // case by design, because those months are UNKNOWN, not closed.
      if (resp?.periodLockUnreadable === true) lockUnreadable = true
      if (Array.isArray(resp?.finalizedPeriods)) {
        for (const p of resp.finalizedPeriods) if (p) periods.add(String(p))
      }

      if (reported && committed < chunk.length) {
        needsReread = true
      } else {
        const chunkSet = new Set(chunk)
        allExpenses.value = allExpenses.value.map(e =>
          chunkSet.has(e.id) ? { ...e, status } : e
        )
      }
    }
  } catch (err) {
    failure = err?.message || 'Bulk update failed'
    // A throw mid-run leaves earlier chunks committed and this one unknown.
    needsReread = true
  }

  // Re-read BEFORE reporting, so the counts in the notice and the rows beneath
  // it are describing the same thing.
  if (needsReread) await quietReload()

  // Keep the selection only where retrying is the actual fix \u2014 a hard failure,
  // or a lock table that could not be read. Rows withheld by a genuinely
  // finalized month will be withheld again, so holding them selected only
  // invites a second click that does nothing.
  const retryable = Boolean(failure) || lockUnreadable
  if (!retryable) clearSelection()
  bulkLoading.value = false

  if (!failure && !withheld && !missing && updated >= sent) {
    toast(`${updated} expense${updated === 1 ? '' : 's'} ${verb}`, 'success')
    return
  }

  bulkOutcome.value = {
    verb, status, sent, updated, withheld, missing,
    periods: [...periods].sort(), lockUnreadable, failure, retryable, reread: needsReread,
  }
  toast(
    failure || `${updated} of ${sent} ${verb} \u2014 ${sent - updated} unchanged`,
    failure ? 'error' : 'warning',
  )
}

// "April 2026" / "April 2026 and May 2026" / "April 2026, May 2026 and June 2026".
// Reuses this file's own monthLabel — the same formatter that tells a filer
// which month a receipt was booked to — so a month reads identically wherever
// this panel names one.
function periodList(periods) {
  const names = periods.map(p => monthLabel(p) || p).filter(Boolean)
  if (names.length <= 1) return names[0] || ''
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

// Headline: what was asked for, against what the database now holds.
const bulkOutcomeHeadline = computed(() => {
  const o = bulkOutcome.value
  if (!o) return ''
  if (o.updated === 0) return `Nothing was ${o.verb}.`
  return `${o.updated} of ${o.sent} ${o.verb}.`
})

// Why the rest were not \u2014 one sentence per distinct reason, never merged.
//
// The finalized branch and the unreadable branch say different things ON PURPOSE
// and must stay apart. "April 2026 is finalized" is a statement about month-end
// close; "the lock table could not be read" is a statement about a fault, and
// the months involved are UNKNOWN \u2014 the server sends `finalizedPeriods: []`
// there precisely so this cannot assert a close that never happened.
const bulkOutcomeReasons = computed(() => {
  const o = bulkOutcome.value
  if (!o) return []
  const out = []
  if (o.withheld > 0) {
    const n = `${o.withheld} receipt${o.withheld === 1 ? '' : 's'}`
    const its = o.withheld === 1 ? 'Its status is' : 'Their statuses are'
    if (o.lockUnreadable) {
      out.push(`${n} could not be ${o.verb}: the month-end close table could not be read, so no month could be confirmed open and ${o.withheld === 1 ? 'it was' : 'they were'} withheld. ${its} unchanged. This is a fault reading the close table, not a closed month \u2014 which months are involved is unknown.`)
    } else if (o.periods.length) {
      out.push(`${n} sit in ${periodList(o.periods)}, which month-end close has finalized, so the server declined ${o.withheld === 1 ? 'it' : 'them'}. ${its} unchanged.`)
    } else {
      out.push(`${n} were declined by month-end close. ${its} unchanged.`)
    }
  }
  if (o.missing > 0) {
    out.push(`${o.missing} selected row${o.missing === 1 ? '' : 's'} no longer exist${o.missing === 1 ? 's' : ''} \u2014 deleted while the batch was open.`)
  }
  // Any shortfall the server did not attribute. Named as unexplained rather than
  // folded into a reason it might not belong to — but NOT when the run threw,
  // because then the shortfall already has a cause and the failure line below
  // is it. Reporting both would count the same rows twice.
  const unexplained = o.sent - o.updated - o.withheld - o.missing
  if (unexplained > 0 && !o.failure) {
    out.push(`${unexplained} further row${unexplained === 1 ? '' : 's'} ${unexplained === 1 ? 'was' : 'were'} not changed, for a reason the server did not give.`)
  }
  if (o.failure) {
    out.push(`The request failed part-way through, so ${o.sent - o.updated} row${o.sent - o.updated === 1 ? '' : 's'} may not have been reached at all: ${o.failure}`)
  }
  return out
})

// What has already been done for the reader, and what is left to them.
const bulkOutcomeFootnote = computed(() => {
  const o = bulkOutcome.value
  if (!o) return ''
  const parts = []
  if (o.reread) parts.push('The list below has been re-read from the database, so the statuses shown are the stored ones.')
  if (o.retryable) parts.push('Your selection has been kept so you can retry.')
  return parts.join(' ')
})

// expenses.date is a bare 'YYYY-MM-DD'. Routed through the shared helper because
// new Date('2026-07-15') parses as UTC MIDNIGHT and renders as Jul 14 in every US
// timezone \u2014 the client reported exactly that against a receipt reading 07/15.
const fmtDate = (d) => fmtYmd(d)

// Upload time. Uses expenses.timestamp (ISO with 'Z'), never created_at, which is
// UTC with no zone marker and would read ~8h early in the browser.
const fmtUploaded = (t) => fmtTimestamp(t)

// A receipt dated far from when it was filed is nearly always a misread year — a
// store printer with a wrong clock, or a handwritten year that ran off the page.
// It is not cosmetic: the expense lands in a month that isn't in the books, so it
// silently drops out of the P&L. One live row was dated 2017, buckets to 2017-07
// (a period that doesn't exist), and overstates July 2026's investor payout by the
// $100 that never got deducted.
//
// The entry forms already warn, but that fires once and nothing surfaces it again
// after saving — so it stays flagged in the list where someone can still act on it.
// Flag, never block: a genuinely old receipt can be logged deliberately.
const STALE_RECEIPT_DAYS = 120
function receiptDateSuspect(e) {
  const d = parseYmdLocal(e?.date)
  const up = e?.timestamp ? new Date(e.timestamp) : null
  if (!d || !up || isNaN(up.getTime())) return ''
  const days = Math.round((up - d) / 86400000)
  if (days < -1) return 'Dated after it was uploaded — check the date'
  if (days <= STALE_RECEIPT_DAYS) return ''
  return d.getFullYear() !== up.getFullYear()
    ? `Dated ${d.getFullYear()} but uploaded ${up.getFullYear()} — check the year`
    : `Dated ${days} days before it was uploaded — check the date`
}

// City/State display: both -> "City, ST"; one -> that one; neither -> em-dash.
// Read defensively \u2014 location_city/location_state may be absent until the
// backend lane lands.
function fmtLocation(e) {
  const city = (e?.location_city || '').trim()
  const state = (e?.location_state || '').trim()
  if (city && state) return `${city}, ${state}`
  return city || state || '\u2014'
}

// photo_data is either a legacy base64 image data URI, an image URL under
// /uploads/expense-receipts/, or (since 2026-06) a .pdf URL from the admin
// Log Expense form. PDFs render as a link chip \u2014 never an <img>.
function isPdfReceipt(p) {
  return typeof p === 'string' && (/\.pdf$/i.test(p) || p.startsWith('data:application/pdf'))
}

// Fuel analytics
const fuel = ref({})
const fuelLoading = ref(true)

// --- Fuel-up / receipt reconciliation -------------------------------------
// All of it reads through lib/fuelReview so the panel and the truck record
// agree on what "no reading" means, and so an older server (which sends none of
// these fields) degrades to exactly the screen that shipped before, with no
// `undefined` reaching the DOM.

// '' | 'fills' | 'receipts' | 'volumeless' | 'odometer' — which review queue the
// panel is narrowed to. Same semantic as the load board's "Needs Review only"
// filter: one at a time, and everything unrelated gets out of the way.
const reviewFocus = ref('')

const fuelReviewAvailable = computed(() => isReviewAvailable(fuel.value))
const unmatchedFillRows = computed(() => unmatchedFills(fuel.value))
const unmatchedReceiptRows = computed(() => unmatchedReceipts(fuel.value))
const volumelessRows = computed(() => volumelessReceipts(fuel.value))
const volumelessTotals = computed(() => volumelessSummary(fuel.value))
const odometerConflictRows = computed(() => odometerConflicts(fuel.value))
// Actionable vs closed. Both queues prompt an edit to an expense, and an expense
// in a finalized month cannot be edited — so a locked row is shown but never
// offered as work. `closed` is 0 for every row until the server sends a per-row
// lock flag, which keeps this a no-op rather than a guess.
const volumelessCounts = computed(() => queueCounts(volumelessRows.value))
const odometerCounts = computed(() => queueCounts(odometerConflictRows.value))

// Does the table below actually show everything the summary counts?
//
// The summary is authoritative for the fleet-wide total (it counts server-side,
// over rows this payload may not carry — odometerConflicts already caps at 100).
// The actionable/closed split, by contrast, can only ever be computed from the
// rows in hand, because the lock flag lives per row. So when the two disagree,
// the split has to say which population it is describing — otherwise the panel
// reads "$7,261 across 25 receipts" over a line that adds up to 5 and a table
// with 5 rows in it, and nothing says why.
const volumelessShowingAll = computed(() =>
  !volumelessTotals.value || volumelessTotals.value.count === volumelessRows.value.length
)
const calibrationRows = computed(() => tankCalibration(fuel.value))
const calibrationCheckCount = computed(() => countCalibrationChecks(calibrationRows.value))
const calibrationBimodal = computed(() => anyBimodal(calibrationRows.value))

// Cost/mile, in five states that must never collapse into one another.
//
// The server guards its own division and emits 0 when it cannot divide, so a
// bare `costPerMile: 0` is ambiguous on its own — it means BOTH "nothing to
// measure" and "measured, and it came to less than a cent". `costPerMileBasis`
// is what disambiguates them, which is the whole reason it is on the wire.
//
// Two failure modes, opposite directions, equally bad:
//   · printing "$0.00" over an empty basis — a number where there is no
//     computation, which reads as a broken page rather than a dormant feature.
//     This is what ships on deploy day: refuel detection is off by default, so
//     nothing is matched, so there is no distance to divide by.
//   · printing "—" over a real sub-cent result — the absence of a figure where
//     there IS one. Seen live at 897,010 mi against the handful of receipts
//     matched so far.
// So: an empty basis says WHY it is empty and what fills it in; a real figure
// under a cent says "< $0.01" and keeps its hedge.
//
// An ABSENT basis key (older server) is a third thing again: we cannot explain a
// figure we were told nothing about, so it degrades silently to the bare dash
// this card showed before — the same absent-vs-zero rule the review queues use.
const cpm = computed(() => {
  const raw = fuel.value?.costPerMile
  const v = Number(raw)
  const hasFigure = Number.isFinite(v) && v > 0
  const b = fuel.value?.costPerMileBasis

  if (!b) {
    return { value: hasFigure ? '$' + v.toFixed(2) : '—', note: '', title: '', empty: !hasFigure }
  }

  const miles = Number(b.miles) || 0
  const spend = Number(b.spend) || 0
  const trucks = Number(b.trucks) || 0
  const basisText = `${miles.toLocaleString()} mi on ${trucks} truck${trucks === 1 ? '' : 's'}`

  // Nothing to measure across. Refuel detection is what produces both halves of
  // this figure, so name it rather than leaving a dash to be interpreted.
  if (!trucks || !miles) {
    return {
      value: '—',
      note: 'Not measured yet',
      title: 'Cost per mile is measured between consecutive fuel-ups on the same truck — the distance from the truck’s ELD odometer, the cost from the fuel receipts matched to those fuel-ups. No fuel-ups have been recorded yet, so there is no distance to divide by. This fills in on its own once refuel detection has run.',
      empty: true,
    }
  }

  // Distance but no cost: the ELD half is working and the receipt half is not.
  // That is exactly what the queues below this card are for, so point at them.
  if (!spend) {
    return {
      value: '—',
      note: 'No matched receipts yet',
      title: `The ELD mileage is recorded (${basisText}) but no fuel receipt has been matched to a fuel-up yet, so there is no cost to divide by. The review queues below this card are that same gap.`,
      empty: true,
    }
  }

  const hedge = `Biased low, and deliberately labelled "at least": the mileage covers everything these trucks drove, but the spend ($${spend.toLocaleString()}) only counts fuel receipts we actually hold. Every receipt still missing from the review queues below pushes this number down.`

  // A real result the server's 2dp rounding flattened to zero. Showing "$0.00"
  // would claim free diesel; showing "—" would deny a computation that happened.
  if (!hasFigure) {
    return {
      value: '< $0.01',
      note: `at least · ${basisText}`,
      title: `Under a cent per mile — a real figure, not a missing one, and almost certainly an artefact of how few receipts are matched so far. ${hedge}`,
      empty: false,
    }
  }

  // Two decimals always — a bare 0.4 would print "$0.4" and read as a
  // truncation rather than 40 cents.
  return { value: '$' + v.toFixed(2), note: `at least · ${basisText}`, title: hedge, empty: false }
})

// --- Monthly $/Gal, and why one month prints a confident wrong number -------
//
// GET /api/expenses/fuel-analytics divides a month's WHOLE spend by only the
// gallons that were actually recorded (`spend / gallons`, where spend sums every
// fuel receipt and gallons sums `e.gallons || 0`). A receipt carrying a dollar
// amount and no volume therefore lands in the numerator and not the denominator,
// which pushes the price UP. Not hypothetical: 2026-07 rendered $7.95/gal
// against diesel nearer $3.50, and the 27 receipts ($6,041.54) in the "Receipts
// missing gallons" queue on this same screen ARE the missing volume.
//
// Two consequences, and the fact that the error has a known DIRECTION is what
// makes both of them statable rather than just flagged:
//   · recorded gallons can only ever be an UNDER-count, so spend ÷ recorded is
//     an UPPER bound — the true price is at most what is shown. Precisely the
//     mirror of the Cost/Mile card, whose SPEND is the under-counted half and
//     which therefore says "at least".
//   · a month with no recorded gallons at all has nothing to divide by; the
//     server emits 0 there and the old markup printed "$0" — a measurement that
//     never happened, and worse than a dash because it looks like one. It now
//     reads "—" for the same reason the Avg $/Gallon card does.
//
// Deliberately NOT computed here: a "corrected" price over just the receipts
// that did record a volume. That needs `spend - volumelessAmount` as the
// numerator, and the queue excludes DEF and non-positive rows which `spend`
// still includes, so the subtraction is not exact. A second, more precise-
// looking number that is quietly wrong is the defect being fixed, not a fix.

// Volumeless receipts grouped by their own month. Derived from the queue rows
// because `volumelessSummary` is fleet-wide with no month breakdown. Safe to
// join on the month key: both sides slice the receipt's own `expenses.date`
// (monthlyData does it server-side, the queue ships it as `localDay`), so the
// two cannot disagree about which month a receipt falls in.
const volumelessByMonth = computed(() => {
  const acc = new Map()
  for (const r of volumelessRows.value) {
    const month = String(r.localDay || '').slice(0, 7)
    if (!/^\d{4}-\d{2}$/.test(month)) continue
    const cur = acc.get(month) || { count: 0, amount: 0 }
    cur.count += 1
    cur.amount += r.amount ?? 0
    acc.set(month, cur)
  }
  return acc
})

// Precomputed per row rather than resolved per cell, for the same reason
// fillRows is: the figure and the chip qualifying it must be derived together or
// they can drift into disagreeing about the same month.
const fuelMonthRows = computed(() => {
  const known = isQueueAvailable(fuel.value, 'volumeless')
  return asList(fuel.value?.monthlyData).map((m) => {
    const month = String(m?.month || '')
    const label = monthLabel(month) || month
    const spend = Number(m?.spend) || 0
    const gallons = Number(m?.gallons) || 0
    const avg = Number(m?.avgPerGallon)
    const gap = volumelessByMonth.value.get(month) || null
    // A capped queue makes the per-month tally a FLOOR, not a count. It only
    // strengthens the "at most" claim (more missing volume = lower true price),
    // but the number itself still has to admit it is a floor.
    const atLeast = gap && !volumelessShowingAll.value ? 'at least ' : ''
    const gapText = gap
      ? `${atLeast}${gap.count} receipt${gap.count === 1 ? '' : 's'} totalling ${fmtMoney(gap.amount)}`
      : ''
    const gapVerb = gap && gap.count === 1 ? 'has' : 'have'
    const gapCarry = gap && gap.count === 1 ? 'carries' : 'carry'
    const pointer = 'They are listed in the “Receipts missing gallons” queue above — opening one and typing the volume off the paper is what fixes this figure.'
    const row = { month, spend, gallons }

    // Nothing to divide by. The old markup printed "$0" here.
    if (gallons <= 0) {
      return {
        ...row,
        value: '—',
        empty: true,
        flag: gap ? 'no gallons' : '',
        title: gap
          ? `No fuel receipt dated ${label} recorded a volume, so there is nothing to divide its ${fmtMoney(spend)} of spend by. ${gapText} in this month ${gapCarry} a dollar amount and no gallons. ${pointer}`
          : `No gallons are recorded against ${label}, so there is no volume to divide the spend by. A price per gallon needs both halves.`,
      }
    }

    // Real division happened. Two decimals always — a bare 3.5 would print
    // "$3.5" and read as a truncation rather than three-fifty.
    const figure = Number.isFinite(avg) && avg > 0 ? '$' + avg.toFixed(2) : '< $0.01'
    const subCent = !(Number.isFinite(avg) && avg > 0)

    if (gap) {
      return {
        ...row,
        // The hedge goes INLINE with the number, not under it: in a dense table
        // a qualifier on its own line is read as decoration, and this one
        // changes what the number means.
        value: subCent ? figure : `at most ${figure}`,
        empty: false,
        flag: 'partial',
        title: `Spend for ${label} counts every fuel receipt, but the gallons count only the receipts that recorded a volume — so the denominator is short and this figure is biased HIGH. ${gapText} in this month ${gapVerb} a dollar amount and no gallons, so the real price is lower than ${figure}. ${pointer}`,
      }
    }

    return {
      ...row,
      value: figure,
      empty: false,
      flag: '',
      // Only claimable when the server actually answered the question. With the
      // queue absent this stays blank rather than asserting a completeness
      // nobody established — the same absent-vs-empty rule as reviewClearPhrases.
      title: known
        ? `Every fuel receipt dated ${label} recorded its gallons, so this price rests on the month's full volume.`
        : '',
    }
  })
})

const fuelMonthsFlagged = computed(() => fuelMonthRows.value.filter((r) => r.flag).length)

// The four queues as data, so the toggle bar is one loop instead of four
// near-identical buttons that drift apart. Only the BAR is generic — each queue
// still renders its own section with its own columns and its own copy, because
// "no fuel-up for this receipt", "no gallons on this receipt" and "this odometer
// disagrees with the ELD" are three different problems with three different
// fixes and must not read as one undifferentiated pile.
//
// `available` is per-queue on purpose: these do not all ship together (see
// isQueueAvailable), so one queue's silence must not suppress another's answer.
const reviewQueues = computed(() => [
  {
    key: 'fills',
    available: isQueueAvailable(fuel.value, 'fills'),
    // The two original queues carry no lock flag on the wire, so queueCounts
    // reports every row as actionable and their toggles render exactly as they
    // did before close-awareness existed. Routed through the same helper anyway
    // so that adding the flag server-side is all it would take.
    ...queueCounts(unmatchedFillRows.value),
    label: 'Fuel-ups without a receipt',
    onTitle: 'Showing only fuel-ups with no receipt',
    offTitle: 'Show only fuel-ups the ELD saw with no receipt filed',
  },
  {
    key: 'receipts',
    available: isQueueAvailable(fuel.value, 'receipts'),
    ...queueCounts(unmatchedReceiptRows.value),
    label: 'Receipts without a fuel-up',
    onTitle: 'Showing only receipts with no matching fuel-up',
    offTitle: 'Show only receipts with no matching rise in the truck’s tank',
  },
  {
    key: 'volumeless',
    available: isQueueAvailable(fuel.value, 'volumeless'),
    ...volumelessCounts.value,
    label: 'Receipts missing gallons',
    onTitle: 'Showing only fuel receipts with no gallons recorded',
    offTitle: 'Show only fuel receipts with a dollar amount but no gallons',
  },
  {
    key: 'odometer',
    available: isQueueAvailable(fuel.value, 'odometer'),
    ...odometerCounts.value,
    label: 'Odometer conflicts',
    onTitle: 'Showing only receipts whose odometer the ELD contradicts',
    offTitle: 'Show only receipts whose typed odometer disagrees with the ELD',
  },
])

// Buttons for queues that answered and hold ROWS — including rows that are only
// closed. A queue whose remaining entries all sit in finalized months still has
// something a reviewer should be able to look at; it just isn't work.
const reviewToggles = computed(() => reviewQueues.value.filter(q => q.available && q.total > 0))

// The count shown on a toggle. `actionable` leads because that is what the
// number is for; a closed tally rides alongside instead of being folded in.
// When nothing is actionable the closed figure becomes the label outright,
// rather than a misleading "(0)".
function queueCountText(q) {
  if (!q.closed) return `(${q.actionable})`
  if (!q.actionable) return `(${q.closed} closed)`
  return `(${q.actionable}) · ${q.closed} closed`
}

// Reassurance limited to what this payload actually established — never the old
// fixed sentence, which would speak for queues the server never answered.
const reviewClearText = computed(() => {
  if (reviewToggles.value.length) return ''
  const parts = reviewClearPhrases(fuel.value)
  if (!parts.length) return ''
  const joined = parts.length === 1
    ? parts[0]
    : parts.slice(0, -1).join(', ') + ', and ' + parts[parts.length - 1]
  return 'All clear — ' + joined + '.'
})

// A queue shows whenever it has rows, and stays on screen when focused even if
// a background refresh empties it — that is when the "why it's empty" message
// earns its place.
function queueVisible(key, rows) {
  return reviewFocus.value === key || (!reviewFocus.value && rows.length > 0)
}
const showFillsQueue = computed(() => queueVisible('fills', unmatchedFillRows.value))
const showReceiptsQueue = computed(() => queueVisible('receipts', unmatchedReceiptRows.value))
const showVolumelessQueue = computed(() => queueVisible('volumeless', volumelessRows.value))
const showOdometerQueue = computed(() => queueVisible('odometer', odometerConflictRows.value))

function toggleReviewFocus(which) {
  reviewFocus.value = reviewFocus.value === which ? '' : which
}

// Lifted verbatim from ActiveLoadsTab's reviewToggleStyle so the two review
// affordances are the same object on screen: amber when active, neutral outline
// when not.
function fuelReviewToggleStyle(which) {
  const on = reviewFocus.value === which
  return {
    display: 'inline-flex', alignItems: 'center', whiteSpace: 'nowrap',
    padding: '0.4rem 0.75rem', fontSize: '0.75rem', fontWeight: '600',
    borderRadius: '6px', cursor: 'pointer', fontFamily: 'inherit',
    border: '1px solid ' + (on ? '#f59e0b' : '#d1d5db'),
    background: on ? '#fef3c7' : '#ffffff',
    color: on ? '#92400e' : '#374151',
    transition: 'all 0.15s',
  }
}

// Display-ready recent fills. Precomputed rather than calling the formatters
// per-cell so a row's number and its provenance chip can never disagree.
const fillRows = computed(() =>
  asList(fuel.value?.recentFills).map(f => ({
    ...f,
    odoText: fmtOdometer(f?.odometer),
    // Always present on the wire, explicitly null when the server can't
    // attribute the reading — and it is a stored column written in the same
    // statement as the value, not inferred by comparing numbers, so it can't
    // drift. No cross-check here; trust it or show no chip.
    odoSrc: odometerSource(f?.odometerSource),
    odoSuspect: isSuspectOdometer(f?.odometer, f?.odometerSource),
  }))
)
const anyOdoSource = computed(() => fillRows.value.some(f => f.odoSrc))

// Before/after when both ends are known, otherwise just the size of the jump —
// some shapes of the reconciliation payload carry the rise without the two
// endpoints, and "+76 pts" is still the fact the reviewer needs.
function tankRiseText(f) {
  if (f?.pctBefore === null || f?.pctAfter === null) {
    return f?.risePts === null || f?.risePts === undefined ? '—' : `+${f.risePts} pts`
  }
  const rise = f.risePts === null ? '' : ` (+${f.risePts} pts)`
  return `${Math.round(f.pctBefore)}% → ${Math.round(f.pctAfter)}%${rise}`
}

// The spread beside the headline figure, drawn from the same population — the
// lower mode's own min/max on a twin-tank truck, the interquartile range
// otherwise (a single outlier fill shouldn't make a steady truck look uncertain).
function calibrationRange(c) {
  if (c?.rangeLow === null || c?.rangeHigh === null) return '—'
  if (c.rangeLow === c.rangeHigh) return `${c.rangeLow} gal`
  return `${c.rangeLow}–${c.rangeHigh} gal`
}

// Three of the four queues (receipts, missing gallons, odometer conflicts) point
// at an expense row, and all three link back to it through the detail modal that
// already exists on this tab — Teleported to <body>, so it opens over the Fuel
// Logs panel without dragging the reviewer off to another sub-tab. That modal is
// where the actual fix happens: open the receipt image, read the gallons or the
// real odometer off it, correct the row.
//
// It resolves by id against `allExpenses`, which the All Expenses filters can
// legitimately exclude, so check first and say so: opening a modal that renders
// nothing is worse than not opening one. This matters most for odometer
// conflicts — that queue is deliberately not date-windowed, so its rows are
// routinely older than whatever range the reviewer has typed into the filters.
function openReceiptRow(r) {
  if (r?.id == null) return
  // A finalized month is not editable, so this row is reference-only. The row is
  // already visibly marked and not styled as clickable; this is the backstop for
  // a keyboard activation or a future caller, and it explains rather than no-ops
  // silently — a row that looks disabled and also says nothing is the worst of
  // the three options.
  if (r.locked === true) {
    toast(`${r.periodLabel || 'That month'} is closed — this receipt is shown for reference and can no longer be edited.`, 'warning')
    return
  }
  if (!allExpenses.value.some(e => e.id === r.id)) {
    toast('That receipt is outside the current All Expenses filters — clear them to open it.', 'warning')
    return
  }
  selectedId.value = r.id
}

// --- Clickable rows, made reachable from the keyboard ----------------------
//
// Every clickable <tr> on this tab goes through these two helpers, in one pass,
// so the five tables cannot drift into being keyboard-operable in different
// ways — which is the state they were in before (none of them were) and the
// reason it was easier to leave alone than to fix half.
//
// The pattern is lifted from VendorLeaderboardTable.vue, the one clickable-row
// table in this feature that already had it: `tabindex="0"` + an aria-label +
// key activation, and deliberately NO `role="button"` on the row. A role of
// button on a <tr> overrides its implicit `row` role, which takes its cells with
// it — a screen reader then announces a button and loses the column structure
// that makes a data table readable. Focusability is what these rows were
// missing; their semantics were already right.

// Activate a row from the keyboard.
//
// Guarded on `e.target === e.currentTarget`, which is load-bearing rather than
// defensive: these rows contain their own controls — the All Expenses row has a
// select checkbox and Approve/Reject buttons — and Space on a focused checkbox
// must keep toggling it. Without the guard the keypress bubbles to the row,
// opens the detail modal, and `preventDefault` cancels the toggle that the user
// actually asked for. So a row only answers a key that was aimed at the row.
//
// preventDefault is needed for Space (which scrolls the page) and harmless for
// Enter. Both are handled because a focusable thing that opens something is
// expected to answer both.
function rowKeyActivate(e, fn) {
  if (e.target !== e.currentTarget) return
  if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return
  e.preventDefault()
  fn()
}

// ONE string for the pointer tooltip and the accessible name, so the mouse and
// the screen reader can never be told different things about the same row.
//
// A locked row keeps its tabindex on purpose. `aria-disabled` (unlike a real
// `disabled`) means "present and discoverable, but not actionable" — dropping
// such a row out of the tab order would hide from a keyboard user that it is
// there at all, and these rows are listed precisely so the gap stays visible.
// Activating one is already handled: openReceiptRow refuses it and says why,
// which its own comment describes as the backstop for a keyboard activation.
function reviewRowAction(row, openText) {
  return row?.locked === true
    ? `${row.periodLabel || 'This month'} is closed — shown for reference, no longer editable`
    : openText
}

// Money for the review queues. Always two decimals and always grouped, so a
// column of amounts lines up and "$5,881.54" can't be misread as "$5,881.5".
function fmtMoney(v) {
  return v === null || v === undefined
    ? '—'
    : '$' + Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

// The gap between a typed odometer and the machine's. Rendered whole — this is
// the number that makes a six-digit disagreement register as a typo rather than
// as two plausible readings, so it is never abbreviated to "852k".
function conflictDeltaText(c) {
  if (c?.deltaMi === null) return '—'
  return Math.round(c.deltaMi).toLocaleString('en-US') + ' mi'
}

// Maintenance fund
const maint = ref({})
const maintLoading = ref(true)
const maintSubmitting = ref(false)
const maintForm = reactive({
  type: 'contribution',
  amount: '',
  truck: '',
  // Local day, NOT toISOString(): the UTC day is already tomorrow after 7pm
  // Houston, and this date is the month key the investor payout books against —
  // a Jul 31 evening PM service would otherwise land in August.
  date: houstonToday(),
  description: '',
})

// IFTA / Compliance
const ifta = ref({})
const iftaLoading = ref(true)
const iftaStart = ref('2026-01-01')
// Houston day, not the UTC day: after 7 PM Houston toISOString() is already
// tomorrow, which defaulted this tax-report range end to a day that hasn't
// happened yet.
const iftaEnd = ref(houstonToday())
const fees = ref({})
const feeSubmitting = ref(false)
const feeForm = reactive({
  type: '2290',
  amount: '',
  truck: '',
  dueDate: '',
  description: '',
})

const iftaStatesTracked = computed(() => {
  const set = new Set()
  for (const t of (ifta.value?.trucks || [])) {
    for (const s of (t.states || [])) set.add(s.state)
  }
  return set.size
})

const stateDetail = ref(null)

// IFTA per-state day detail: first/last ELD ping of the day. The server sends
// these as ISO-Z (new Date(location_date_ms).toISOString()) — true instants.
// Houston rule: America/Chicago with a visible zone label.
//
// The locale is pinned to 'en-US' alongside the zone, deliberately: with the
// default locale ([]) an en-GB/fil-PH browser renders timeZoneName as "GMT-5"
// instead of "CDT". Still honest, but the point of the label is that it is
// instantly readable as Houston time, so make it deterministic.
function fmtHM(iso) {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleTimeString('en-US', {
      hour: '2-digit', minute: '2-digit',
      timeZone: 'America/Chicago', timeZoneName: 'short',
    })
  } catch {
    return '—'
  }
}

async function openStateDetail(truck, stateRow) {
  stateDetail.value = {
    truckId: truck.truckId,
    unitNumber: truck.unitNumber,
    state: stateRow.state,
    totalMiles: stateRow.miles,
    days: [],
    loading: true,
  }
  try {
    const params = new URLSearchParams({
      truck_id: truck.truckId,
      state: stateRow.state,
      start: new Date(iftaStart.value + 'T00:00:00').toISOString(),
      end: new Date(iftaEnd.value + 'T23:59:59').toISOString(),
    })
    const data = await api.get('/api/compliance/ifta/state-detail?' + params.toString())
    stateDetail.value = { ...stateDetail.value, ...data, loading: false }
  } catch {
    if (stateDetail.value) stateDetail.value.loading = false
  }
}

function closeStateDetail() { stateDetail.value = null }

// `quiet` skips the skeleton so a post-edit refresh doesn't blank the panel the
// reviewer is working in — same distinction loadAll/quietReload draws.
async function loadFuel({ quiet = false } = {}) {
  if (!quiet) fuelLoading.value = true
  try {
    fuel.value = await api.get('/api/expenses/fuel-analytics')
  } catch { /* empty — leave the existing figures in place */ }
  if (!quiet) fuelLoading.value = false
}

async function loadMaintenance() {
  maintLoading.value = true
  try {
    maint.value = await api.get('/api/maintenance-fund')
  } catch { /* empty */ }
  maintLoading.value = false
}

async function loadIfta() {
  iftaLoading.value = true
  try {
    const params = new URLSearchParams({
      start: new Date(iftaStart.value + 'T00:00:00').toISOString(),
      end: new Date(iftaEnd.value + 'T23:59:59').toISOString(),
    })
    const [iftaData, feesData] = await Promise.all([
      api.get('/api/compliance/ifta?' + params.toString()),
      api.get('/api/compliance/fees'),
    ])
    ifta.value = iftaData
    fees.value = feesData
  } catch { /* empty */ }
  iftaLoading.value = false
}

async function submitMaintEntry() {
  if (!maintForm.amount || !maintForm.date) {
    toast('Enter amount and date', 'error')
    return
  }
  maintSubmitting.value = true
  try {
    await api.post('/api/maintenance-fund', { ...maintForm })
    toast(maintForm.type === 'contribution' ? 'Contribution logged' : 'PM service logged', 'success')
    maintForm.amount = ''
    maintForm.description = ''
    maintForm.truck = ''
    await loadMaintenance()
  } catch {
    toast('Failed to save entry', 'error')
  }
  maintSubmitting.value = false
}

async function submitFee() {
  if (!feeForm.amount || !feeForm.dueDate) {
    toast('Enter amount and due date', 'error')
    return
  }
  feeSubmitting.value = true
  try {
    await api.post('/api/compliance/fees', { ...feeForm })
    toast('Fee added', 'success')
    feeForm.amount = ''
    feeForm.description = ''
    feeForm.truck = ''
    feeForm.dueDate = ''
    await loadIfta()
  } catch {
    toast('Failed to save fee', 'error')
  }
  feeSubmitting.value = false
}

async function markFeePaid(id) {
  try {
    await api.put(`/api/compliance/fees/${id}`, {
      // Local day, NOT toISOString() — the UTC day rolls at 7pm Houston, and
      // paid_date is another payout month key.
      paidDate: houstonToday(),
    })
    toast('Fee marked as paid', 'success')
    await loadIfta()
  } catch {
    toast('Failed to update fee', 'error')
  }
}

// Refresh data quietly when the server emits expenses:changed (this tab's
// own approvals, or another admin's actions). NOT a key-remount — the open
// detail modal must survive. The Analytics panel (when open) re-pulls its
// aggregates too, also without a skeleton flash.
useSocketRefresh('expenses:changed', () => {
  quietReload()
  if (activeSubTab.value === 'analytics') analyticsPanel.value?.reload()
})

onMounted(() => {
  loadAll()
  loadTruckList()
})
// Defer per-tab analytics until their sub-tab is first opened. The list view
// doesn't need the fuel/maintenance/IFTA aggregates (IFTA especially crunches
// the large telemetry table), so loading them on mount just slowed the initial
// page. Each loads once, lazily, when its tab is first shown.
const _tabLoaded = { fuel: false, maintenance: false, ifta: false }
watch(activeSubTab, (tab) => {
  if (tab === 'fuel' && !_tabLoaded.fuel) { _tabLoaded.fuel = true; loadFuel() }
  if (tab === 'maintenance' && !_tabLoaded.maintenance && auth.isSuperAdmin) { _tabLoaded.maintenance = true; loadMaintenance() }
  if (tab === 'ifta' && !_tabLoaded.ifta && auth.isSuperAdmin) { _tabLoaded.ifta = true; loadIfta() }
})
</script>

<style scoped>
.expenses-tab {
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}

.sub-tabs {
  display: flex;
  gap: 0;
  border-bottom: 1px solid var(--border);
  padding: 0 1rem;
  flex-shrink: 0;
}

.sub-tab {
  padding: 0.6rem 1rem;
  border: none;
  background: transparent;
  font-family: 'DM Sans', sans-serif;
  font-size: 0.8rem;
  font-weight: 600;
  color: var(--text-dim);
  cursor: pointer;
  border-bottom: 2px solid transparent;
  transition: all 0.15s;
}

.sub-tab:hover { color: var(--text); }
.sub-tab.active { color: var(--accent); border-bottom-color: var(--accent); }

.sub-panel {
  flex: 1;
  overflow-y: auto;
  padding: 1.25rem;
}

/* Metrics grid */
.metrics-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 0.75rem;
  margin-bottom: 1rem;
}

.metric-card {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 0.85rem 1rem;
}

.metric-card.accent {
  border-color: var(--accent);
  background: var(--accent-dim);
}

.metric-label {
  font-size: 0.7rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-dim);
  margin-bottom: 0.25rem;
}

.metric-value {
  font-family: 'JetBrains Mono', monospace;
  font-size: 1.15rem;
  font-weight: 700;
}

/* Compliance card */
.compliance-card {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 1rem;
  margin-bottom: 1rem;
}

.compliance-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 0.82rem;
  font-weight: 600;
  margin-bottom: 0.6rem;
}

.compliance-badge {
  font-size: 0.7rem;
  font-weight: 700;
  padding: 0.2rem 0.6rem;
  border-radius: 10px;
}

.compliance-badge.on-target {
  background: rgba(16,185,129,0.15);
  color: #059669;
}

.compliance-badge.off-target {
  background: var(--danger-dim);
  color: var(--danger);
}

.progress-bar {
  height: 8px;
  background: var(--border);
  border-radius: 4px;
  overflow: hidden;
  margin-bottom: 0.4rem;
}

.progress-fill {
  height: 100%;
  background: var(--accent);
  border-radius: 4px;
  transition: width 0.3s ease;
}

.progress-fill.danger {
  background: var(--danger);
}

.compliance-detail {
  font-size: 0.72rem;
  color: var(--text-dim);
}

/* Section cards */
.section-card {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 1rem;
  margin-bottom: 1rem;
}

.section-title {
  font-size: 0.82rem;
  font-weight: 700;
  margin-bottom: 0.75rem;
}

/* ---- Fuel-up / receipt reconciliation ---------------------------------
 * Amber palette borrowed wholesale from the load board's "Needs Review"
 * treatment (#fef3c7 / #fde68a / #92400e) so a review queue looks the same
 * wherever it appears. Nothing here is red: these are queues to work
 * through, not failures. */
.fuel-review-bar {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
  margin-bottom: 1rem;
}
.fuel-review-clear {
  font-size: 0.75rem;
  color: var(--text-dim);
}

.section-title.cal-title {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
.cal-count-badge {
  display: inline-flex;
  align-items: center;
  padding: 1px 7px;
  font-size: 0.65rem;
  font-weight: 700;
  border-radius: 10px;
  border: 1px solid #fde68a;
  background: #fffbeb;
  color: #92400e;
  cursor: help;
}
.cal-note {
  font-size: 0.72rem;
  line-height: 1.5;
  color: var(--text-dim);
  margin: -0.35rem 0 0.75rem;
  max-width: 68ch;
}
.cal-note strong { color: var(--text); font-weight: 600; }
/* The twin-tank explanation. Amber-tinted so it reads as "here is why these
   numbers look odd" rather than as more body copy nobody finishes. */
.cal-note-flag {
  background: #fffbeb;
  border: 1px solid #fde68a;
  border-radius: var(--radius);
  padding: 0.6rem 0.75rem;
  color: #78350f;
  margin-top: -0.25rem;
}
.cal-note-flag strong { color: #78350f; }
.cal-basis { color: #92400e; }
.metric-sub {
  margin-top: 0.2rem;
  font-size: 0.66rem;
  color: var(--text-dim);
  cursor: help;
}
/* An empty metric should look deliberately empty, not like a number that failed
 * to arrive. The dash is dimmed to sit back from the real figures beside it, and
 * the note under it is italic so it reads as a state ("not measured yet") rather
 * than as the "at least · 19,425 mi" basis line it replaces. */
.metric-value-empty { color: var(--text-dim); font-weight: 500; }
.metric-sub-empty { font-style: italic; }

.cal-row-check td { background: #fffbeb; }
tr.cal-row-check:hover td { background: #fef3c7; }
.cal-range { color: var(--text-dim); }
.cal-unset { color: var(--text-dim); cursor: help; }
.cal-ok { font-size: 0.75rem; color: var(--text-dim); }
.cal-badge {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  padding: 0.15rem 0.5rem;
  border-radius: 10px;
  font-size: 0.68rem;
  font-weight: 700;
  border: 1px solid #fde68a;
  background: #fffbeb;
  color: #92400e;
  cursor: help;
}
.cal-thin {
  margin-left: 0.3rem;
  font-family: 'DM Sans', sans-serif;
  font-size: 0.62rem;
  font-weight: 600;
  color: var(--text-dim);
  cursor: help;
}

/* Focus ring for every activatable row on this tab — ONE rule, shared by all
   five tables, so they cannot drift into looking focused in different ways.
   Matches VendorLeaderboardTable's .vlt-row:focus-visible exactly. The negative
   offset keeps the ring inside the row box; drawn outside, it is clipped by the
   table's overflow container on the horizontally-scrolling All Expenses table
   and the top and bottom edges disappear. */
.row-activatable:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}
/* A closed row is focusable (aria-disabled means discoverable-but-inert) but
   must not look like work. Dimmer ring, so tabbing still shows where you are
   without promising an action the row cannot perform. */
.review-row-locked.row-activatable:focus-visible { outline-color: var(--text-dim); }

/* Monthly $/Gal. `white-space: nowrap` so "at most $7.95" cannot wrap and leave
   the hedge stranded on its own line, where it would read as a separate cell. */
.fuel-mo-rate { white-space: nowrap; }
/* A dash that is a statement, not a blank. Same treatment as .metric-value-empty
   on the Avg $/Gallon card, so "we cannot divide" looks identical wherever this
   panel says it. */
.fuel-mo-unmeasured { color: var(--text-dim); cursor: help; }
/* Amber, unlike a plain .cal-thin: this chip marks a figure that is wrong in a
   known direction, which is a finding, not a footnote. */
.fuel-mo-flag { color: #92400e; }
.fuel-mo-note { margin-top: 0.6rem; }

.review-card { border-color: #fde68a; }
.review-row-clickable { cursor: pointer; }

/* A row in a finalized month. Quiet, not alarming — the point is "there is
 * nothing to do here", not "something is wrong here". Deliberately still
 * legible: the figures are the reason the row is listed at all, so this dims
 * the row's affordance, not its content. `cursor: default` plus no hover tint
 * is what stops it reading as clickable in the first place; the `closed` chip
 * is what says why. */
.review-row-locked { cursor: default; background: var(--bg); }
.review-row-locked td { color: var(--text-dim); }
/* Drop the amber on a closed row. The emphasis colour in these tables means
 * "this is yours to fix", so leaving it at full strength made a locked row
 * compete with an actionable one for attention while being the only one nobody
 * can do anything about. Weight and the dotted underline stay, so the row still
 * says WHICH number is the wrong one — the finding survives, the call to action
 * doesn't. */
.review-row-locked .odo-conflict-suspect {
  color: var(--text-dim);
  text-decoration-color: var(--text-dim);
}
.review-row-locked .odo-conflict-delta { color: var(--text-dim); }
.closed-chip {
  display: inline-block;
  margin-left: 0.35rem;
  padding: 0 5px;
  font-family: 'DM Sans', sans-serif;
  font-size: 0.6rem;
  font-weight: 700;
  line-height: 1.5;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  border-radius: 4px;
  vertical-align: middle;
  cursor: help;
  background: var(--bg);
  color: var(--text-dim);
  border: 1px solid var(--border);
}
/* Neutral twin of .cal-count-badge. Same geometry so the two sit level in a
 * heading, different colour so "work" and "closed" never read as one number. */
.closed-count-badge {
  display: inline-flex;
  align-items: center;
  padding: 1px 7px;
  font-size: 0.65rem;
  font-weight: 700;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: var(--bg);
  color: var(--text-dim);
  cursor: help;
}

/* Missing-gallons rollup. The money leads, because "$5,881 of diesel with no
   volume" is the sentence that gets the queue worked; the per-truck chips
   underneath are what name the truck to start with. */
.vol-summary {
  margin: -0.25rem 0 0.85rem;
  padding: 0.65rem 0.75rem;
  border: 1px solid #fde68a;
  border-radius: var(--radius);
  background: #fffbeb;
}
.vol-headline {
  font-size: 0.78rem;
  line-height: 1.5;
  color: #78350f;
}
.vol-headline strong { font-weight: 700; }
.vol-split {
  margin-top: 0.35rem;
  font-size: 0.72rem;
  line-height: 1.5;
  color: #92400e;
}
.vol-split strong { font-weight: 700; }
.vol-trucks {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
  margin-top: 0.55rem;
}
.vol-truck-chip {
  display: inline-flex;
  align-items: baseline;
  gap: 0.4rem;
  padding: 0.2rem 0.55rem;
  border: 1px solid #fcd34d;
  border-radius: 10px;
  background: #fff;
  font-size: 0.7rem;
}
.vol-truck-unit {
  font-family: 'JetBrains Mono', monospace;
  font-weight: 700;
  color: #92400e;
}
.vol-truck-stat { color: var(--text-dim); }

/* Odometer conflict. The typed number is the loud one — it is the one under
   suspicion and the one about to be edited — while the ELD reading sits back in
   the same dimmed treatment `.odo-derived` already gives machine-read values in
   Recent Fuel Fills. Colour is never the only signal: both cells carry a text
   chip, and the Difference column states the gap outright. */
.odo-conflict-suspect {
  color: #92400e;
  font-weight: 700;
  text-decoration: underline dotted #b45309;
  text-underline-offset: 2px;
}
.odo-conflict-delta { color: #92400e; font-weight: 600; white-space: nowrap; }
.odo-conflict-delta .cal-thin { display: block; margin-left: 0; font-weight: 500; }

/* Odometer provenance. The number stays the loud element; the chip is a
 * quiet qualifier. An ELD-derived reading is additionally dimmed so a
 * skim of the column separates "written on the paper" from "worked out by
 * the system" without reading a single chip. */
.odo-cell { white-space: nowrap; }
.odo-value { font-weight: 600; }
.odo-derived { font-weight: 400; color: var(--text-dim); }
.odo-suspect { text-decoration: underline dotted #b45309; }
.odo-src {
  display: inline-block;
  margin-left: 0.35rem;
  padding: 0 5px;
  font-family: 'DM Sans', sans-serif;
  font-size: 0.6rem;
  font-weight: 700;
  line-height: 1.5;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  border-radius: 4px;
  cursor: help;
  vertical-align: middle;
}
.odo-src-receipt { background: #eef2ff; color: #3730a3; border: 1px solid #c7d2fe; }
.odo-src-telemetry { background: #ecfeff; color: #155e75; border: 1px solid #a5f3fc; }
.odo-src-suspect { background: #fffbeb; color: #92400e; border: 1px solid #fde68a; }
.odo-src-none { background: var(--bg); color: var(--text-dim); border: 1px solid var(--border); }
.odo-legend {
  margin: 0.6rem 0 0;
  font-size: 0.68rem;
  line-height: 1.7;
  color: var(--text-dim);
}
.odo-legend .odo-src { margin-left: 0; margin-right: 0.15rem; cursor: default; }

/* Inline form */
.inline-form {
  display: flex;
  gap: 0.5rem;
  align-items: center;
  flex-wrap: wrap;
}

.inline-form .form-select,
.inline-form .form-input {
  padding: 0.45rem 0.6rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  font-family: inherit;
  font-size: 0.8rem;
  background: var(--surface);
  color: var(--text);
  outline: none;
}

.inline-form .form-select { min-width: 130px; }
.inline-form .form-input { width: 100px; }
.inline-form .form-input.sm { width: 80px; }
.inline-form .form-input.wide { flex: 1; min-width: 140px; }

.btn {
  padding: 0.45rem 0.85rem;
  border: none;
  border-radius: var(--radius);
  font-family: inherit;
  font-size: 0.8rem;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s;
  white-space: nowrap;
}

.btn-primary {
  background: var(--accent);
  color: #fff;
}

.btn-primary:hover { opacity: 0.9; }
.btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }

.btn-sm {
  padding: 0.3rem 0.6rem;
  font-size: 0.72rem;
  background: var(--surface-hover);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: var(--radius);
}

.btn-sm:hover { background: var(--accent-dim); color: var(--accent); }

/* Tables */
table { width: 100%; border-collapse: collapse; }
thead { background: var(--surface-hover); }
th {
  padding: 0.55rem 0.75rem;
  text-align: left;
  font-size: 0.68rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-dim);
  border-bottom: 1px solid var(--border);
}
td {
  padding: 0.5rem 0.75rem;
  font-size: 0.82rem;
  border-bottom: 1px solid var(--border);
}
tr:last-child td { border-bottom: none; }
tr:hover td { background: var(--surface-hover); }

.mono { font-family: 'JetBrains Mono', monospace; font-size: 0.78rem; }
.bold { font-weight: 700; }
.text-danger { color: var(--danger); }
.text-accent { color: var(--accent); }

.type-badge {
  display: inline-block;
  font-size: 0.68rem;
  font-weight: 600;
  padding: 0.15rem 0.5rem;
  border-radius: 8px;
}

.type-badge.contribution { background: var(--accent-dim); color: var(--accent); }
.type-badge.service { background: var(--blue-dim); color: var(--blue); }
.type-badge.fee { background: var(--amber-dim); color: var(--amber); }

.status-pill {
  display: inline-block;
  font-size: 0.68rem;
  font-weight: 600;
  padding: 0.15rem 0.5rem;
  border-radius: 8px;
}

.status-pill.pending { background: var(--amber-dim); color: var(--amber); }
.status-pill.paid { background: rgba(16,185,129,0.15); color: #059669; }

.truck-header {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  padding-bottom: 0.6rem;
  margin-bottom: 0.6rem;
  border-bottom: 1px solid var(--border);
}
.truck-title { font-size: 0.95rem; font-weight: 700; }
.truck-sub { font-size: 0.78rem; color: var(--text-dim); }

.state-row { cursor: pointer; }
.state-row:hover td { background: var(--surface-hover); }

.filter-label {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.78rem;
  color: var(--text-dim);
}

.desc-cell {
  max-width: 200px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.empty-msg {
  text-align: center;
  color: var(--text-dim);
  font-size: 0.85rem;
  padding: 2rem 1rem;
}

/* Skeleton */
.skeleton {
  background: linear-gradient(90deg, var(--bg) 25%, var(--surface-hover) 50%, var(--bg) 75%);
  background-size: 200% 100%;
  animation: shimmer 1.5s infinite;
  border-radius: var(--radius);
}
.skeleton-card { height: 120px; margin-bottom: 0.75rem; }

@keyframes shimmer {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}

/* All Expenses tab */
.filter-row {
  display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap;
  padding: 0.75rem 1rem; border-bottom: 1px solid var(--border);
}
.filter-select {
  padding: 0.35rem 0.6rem; border: 1px solid var(--border); border-radius: 6px;
  font-family: inherit; font-size: 0.78rem; background: var(--bg); color: var(--text);
}
.filter-search {
  padding: 0.35rem 0.6rem; border: 1px solid var(--border); border-radius: 6px;
  font-family: inherit; font-size: 0.78rem; background: var(--bg); color: var(--text);
  min-width: 220px; flex: 1 1 220px;
}
.filter-search:focus { outline: none; border-color: var(--accent); }
.filter-count {
  margin-left: auto; font-size: 0.72rem; color: var(--text-dim);
  font-family: 'JetBrains Mono', monospace;
}
.mono-sm { font-family: 'JetBrains Mono', monospace; font-size: 0.75rem; }
.dim { color: var(--text-dim); }
.desc-cell { max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.type-pill {
  display: inline-flex; padding: 0.12rem 0.5rem; border-radius: 10px;
  font-size: 0.66rem; font-weight: 600; text-transform: uppercase;
  letter-spacing: 0.04em;
}
.type-fuel { background: var(--blue-dim, rgba(59,130,246,0.12)); color: var(--blue, #3b82f6); }
.type-toll { background: var(--amber-dim); color: var(--amber); }
.type-repair { background: var(--danger-dim); color: var(--danger); }
.type-food { background: var(--accent-dim); color: var(--accent); }
.type-other { background: var(--bg); color: var(--text-dim); }

.status-pill {
  display: inline-flex; padding: 0.12rem 0.5rem; border-radius: 10px;
  font-size: 0.66rem; font-weight: 600;
}
.st-pending { background: var(--amber-dim); color: var(--amber); }
.st-approved { background: var(--accent-dim); color: var(--accent); }
.st-rejected { background: var(--danger-dim); color: var(--danger); }

.receipt-thumb {
  width: 80px; height: 60px; object-fit: cover; border-radius: 4px;
  cursor: pointer; transition: opacity 0.15s;
  border: 1px solid var(--border);
  background: #fafbfd;
}
.receipt-thumb { cursor: zoom-in; }
.receipt-thumb:hover { opacity: 0.7; }
.receipt-hover-preview {
  position: fixed;
  z-index: 4000;
  background: #fff;
  border: 1px solid #e2e8f0;
  border-radius: 10px;
  box-shadow: 0 14px 44px rgba(15, 23, 42, 0.28);
  padding: 6px;
  box-sizing: border-box;
  pointer-events: none;
  overflow: hidden;
}
.receipt-hover-preview img {
  display: block;
  width: 100%;
  max-height: 100%;
  object-fit: contain;
  border-radius: 6px;
}

/* PDF receipt chip — link out instead of an <img> (table cell, mobile card,
   add-form preview). */
.receipt-pdf-chip {
  display: inline-flex; align-items: center;
  padding: 0.28rem 0.6rem; border-radius: 6px;
  background: var(--danger-dim); color: var(--danger);
  font-size: 0.68rem; font-weight: 700; letter-spacing: 0.04em;
  text-decoration: none; border: 1px solid transparent;
  transition: border-color 0.15s;
}
.receipt-pdf-chip:hover { border-color: var(--danger); }
.add-pdf-chip { max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.exp-receipt-pdf {
  display: inline-flex; align-items: center;
  padding: 0.55rem 0.9rem; border-radius: 8px;
  background: var(--danger-dim); color: var(--danger);
  font-size: 0.8rem; font-weight: 700; text-decoration: none;
  border: 1px solid transparent;
  transition: border-color 0.15s;
}
.exp-receipt-pdf:hover { border-color: var(--danger); }

/* Multi-select + bulk actions */
.select-cell { width: 34px; text-align: center; padding-right: 0.25rem; }
.select-checkbox { width: 15px; height: 15px; cursor: pointer; accent-color: var(--accent); vertical-align: middle; }
.select-checkbox:disabled { cursor: default; opacity: 0.4; }
.bulk-bar {
  display: flex; align-items: center; gap: 0.6rem; flex-wrap: wrap;
  padding: 0.55rem 0.9rem; margin-bottom: 0.75rem;
  background: var(--accent-dim); border: 1px solid var(--accent);
  border-radius: var(--radius);
}
.bulk-count {
  font-size: 0.76rem; font-weight: 700; color: var(--accent);
  font-family: 'JetBrains Mono', monospace;
}
.bulk-btn {
  padding: 0.35rem 0.8rem; font-size: 0.74rem; font-weight: 600;
  border: none; border-radius: 6px; cursor: pointer; font-family: inherit;
  transition: opacity 0.15s;
}
.bulk-approve { background: var(--accent); color: #fff; }
.bulk-reject { background: var(--danger); color: #fff; }
.bulk-btn:hover:not(:disabled) { opacity: 0.85; }
.bulk-clear {
  margin-left: auto; padding: 0.35rem 0.7rem; font-size: 0.74rem; font-weight: 600;
  background: transparent; border: 1px solid var(--border); border-radius: 6px;
  color: var(--text-dim); cursor: pointer; font-family: inherit;
}
.bulk-clear:hover:not(:disabled) { color: var(--text); }
.bulk-btn:disabled, .bulk-clear:disabled { opacity: 0.5; cursor: not-allowed; }

/* Bulk result. Deliberately the SAME amber surface as .vol-summary, the panel's
   existing "this needs your attention and is not an error" treatment — a red
   error box would say the batch failed, which it did not: most of it committed.
   Sits directly under the bulk bar so the result appears where the action was. */
.bulk-outcome {
  margin-bottom: 0.75rem;
  padding: 0.65rem 0.85rem;
  border: 1px solid #fde68a;
  border-radius: var(--radius);
  background: #fffbeb;
}
.bulk-outcome-top {
  display: flex;
  align-items: flex-start;
  gap: 0.6rem;
}
.bulk-outcome-headline {
  flex: 1;
  font-size: 0.8rem;
  font-weight: 700;
  line-height: 1.5;
  color: #78350f;
}
.bulk-outcome-dismiss {
  flex: none;
  padding: 0 0.3rem;
  margin: -0.15rem -0.2rem 0 0;
  font-size: 1.05rem;
  line-height: 1.2;
  background: transparent;
  border: none;
  border-radius: 4px;
  color: #92400e;
  cursor: pointer;
  font-family: inherit;
}
.bulk-outcome-dismiss:hover { background: #fef3c7; }
.bulk-outcome-dismiss:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
.bulk-outcome-reason {
  margin-top: 0.35rem;
  font-size: 0.74rem;
  line-height: 1.55;
  color: #92400e;
}
.bulk-outcome-foot {
  margin-top: 0.45rem;
  font-size: 0.7rem;
  line-height: 1.5;
  color: #a16207;
}

.action-cell { white-space: nowrap; }
.btn-approve, .btn-reject, .btn-undo {
  padding: 0.22rem 0.55rem; font-size: 0.68rem; font-weight: 600;
  border-radius: 5px; border: none; cursor: pointer; font-family: inherit;
  transition: opacity 0.15s;
}
.btn-approve { background: var(--accent-dim); color: var(--accent); margin-right: 0.25rem; }
.btn-reject { background: var(--danger-dim); color: var(--danger); }
.btn-undo { background: var(--bg); color: var(--text-dim); border: 1px solid var(--border); }
.btn-approve:hover, .btn-reject:hover, .btn-undo:hover { opacity: 0.7; }

/* Row click affordance + detail modal */
.expense-row { cursor: pointer; transition: background 0.12s; }
.expense-row:hover { background: #f8fafc; }

.exp-overlay {
  position: fixed; inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex; align-items: center; justify-content: center;
  z-index: 250;
  padding: 1rem;
}
.exp-dialog {
  background: #fff;
  border-radius: 14px;
  width: 100%;
  max-width: 560px;
  max-height: 90vh;
  overflow-y: auto;
  padding: 1.5rem;
  box-shadow: 0 25px 50px rgba(0, 0, 0, 0.25);
}
.exp-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 1.25rem;
}
.exp-type {
  display: inline-block;
  font-size: 0.68rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  padding: 0.2rem 0.55rem;
  border-radius: 6px;
  margin-bottom: 0.5rem;
  background: var(--border); color: var(--text-dim);
}
.exp-type.type-fuel { background: #dbeafe; color: #1e40af; }
.exp-type.type-maintenance, .exp-type.type-repair { background: #fed7aa; color: #9a3412; }
.exp-type.type-toll { background: #ddd6fe; color: #5b21b6; }
.exp-type.type-food { background: #dcfce7; color: #166534; }
.exp-amount { font-size: 1.75rem; font-weight: 800; color: #0f172a; }
.exp-sub { font-size: 0.78rem; color: #64748b; margin-top: 0.25rem; }
.exp-sub-dim { color: #94a3b8; margin-top: 0.1rem; }
/* Upload time is secondary to the receipt date it sits beside. */
.upload-cell { color: #64748b; white-space: nowrap; }
/* Amber, not red: the row saved fine and the date may be legitimate — this asks
   for a look, it doesn't assert an error. */
.date-warn { color: var(--amber, #f59e0b); cursor: help; margin-left: 0.25rem; }
.exp-close {
  background: transparent;
  border: none;
  font-size: 1.5rem;
  color: #94a3b8;
  cursor: pointer;
  padding: 0;
  line-height: 1;
}
.exp-close:hover { color: #0f172a; }
.exp-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.5rem;
  margin-bottom: 1rem;
}
.exp-stat {
  background: #f8fafc;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  padding: 0.65rem 0.85rem;
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
}
.exp-stat-label {
  font-size: 0.62rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: #94a3b8;
}
.exp-stat-value { font-size: 0.95rem; font-weight: 600; color: #0f172a; }

/* City/State stat — spans the full modal width so the inline editor has room */
.exp-stat-location { grid-column: 1 / -1; }
.exp-stat-value-loc { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
.loc-edit-btn {
  padding: 0.15rem 0.5rem; font-size: 0.68rem; font-weight: 600;
  background: var(--accent-dim); color: var(--accent);
  border: none; border-radius: 5px; cursor: pointer; font-family: inherit;
  transition: opacity 0.15s;
}
.loc-edit-btn:hover { opacity: 0.75; }
.loc-edit-row { display: flex; gap: 0.4rem; margin-top: 0.15rem; }
.loc-input {
  flex: 1; min-width: 0;
  padding: 0.35rem 0.5rem; border: 1px solid #e2e8f0; border-radius: 6px;
  font-family: inherit; font-size: 0.82rem; color: #0f172a; background: #fff;
}
.loc-input:focus { outline: none; border-color: var(--accent); }
.loc-input-state { flex: 0 0 3.25rem; text-transform: uppercase; }
.loc-edit-actions { display: flex; gap: 0.4rem; margin-top: 0.45rem; }
.loc-save, .loc-cancel {
  padding: 0.3rem 0.7rem; font-size: 0.72rem; font-weight: 600;
  border-radius: 6px; cursor: pointer; font-family: inherit; border: none;
  transition: opacity 0.15s;
}
.loc-save { background: var(--accent); color: #fff; }
.loc-cancel { background: #f1f5f9; color: #475569; border: 1px solid #e2e8f0; }
.loc-save:hover:not(:disabled), .loc-cancel:hover:not(:disabled) { opacity: 0.8; }
.loc-save:disabled, .loc-cancel:disabled { opacity: 0.5; cursor: not-allowed; }

.exp-desc, .exp-receipt { margin-top: 0.75rem; }
.exp-desc-label {
  font-size: 0.62rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: #94a3b8;
  margin-bottom: 0.4rem;
}
.exp-desc > div:last-child {
  background: #f8fafc;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  padding: 0.75rem 0.9rem;
  font-size: 0.85rem;
  color: #0f172a;
  line-height: 1.4;
}
.exp-receipt-hint {
  font-size: 0.7rem;
  color: #94a3b8;
  margin-top: 0.35rem;
  font-style: italic;
}

.exp-nav {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  padding-bottom: 0.85rem;
  margin-bottom: 0.85rem;
  border-bottom: 1px solid #e2e8f0;
}
.exp-nav-btn {
  background: #f8fafc;
  border: 1px solid #e2e8f0;
  border-radius: 6px;
  padding: 0.35rem 0.7rem;
  font-size: 0.75rem;
  font-weight: 600;
  color: #475569;
  cursor: pointer;
  font-family: inherit;
  transition: all 0.15s;
}
.exp-nav-btn:hover:not(:disabled) { background: #e2e8f0; color: #0f172a; }
.exp-nav-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.exp-nav-counter {
  font-size: 0.72rem;
  font-weight: 600;
  color: #64748b;
  font-family: 'JetBrains Mono', monospace;
}

.exp-actions {
  display: flex;
  gap: 0.6rem;
  margin-top: 1.25rem;
  padding-top: 1rem;
  border-top: 1px solid #e2e8f0;
}
.exp-btn-approve, .exp-btn-reject, .exp-btn-undo {
  flex: 1;
  padding: 0.7rem 1rem;
  border-radius: 8px;
  border: none;
  font-size: 0.85rem;
  font-weight: 700;
  cursor: pointer;
  font-family: inherit;
  transition: all 0.15s;
}
.exp-btn-approve { background: var(--accent); color: #fff; }
.exp-btn-approve:hover:not(:disabled) { opacity: 0.88; }
.exp-btn-reject { background: var(--danger); color: #fff; }
.exp-btn-reject:hover:not(:disabled) { opacity: 0.88; }
.exp-btn-undo { background: #f1f5f9; color: #475569; border: 1px solid #e2e8f0; }
.exp-btn-undo:hover:not(:disabled) { background: #e2e8f0; color: #0f172a; }
.exp-btn-approve:disabled, .exp-btn-reject:disabled, .exp-btn-undo:disabled { opacity: 0.5; cursor: not-allowed; }

/* ---- Fullscreen expense-detail modal (two-column: details | receipt) ----
   Everything below is scoped to .exp-dialog--full so the IFTA state-detail
   modal (which reuses the plain .exp-dialog) keeps its small centered box. */
.exp-dialog--full {
  width: 100%;
  height: 100%;
  max-width: none;
  max-height: none;
  padding: 0;
  border-radius: 12px;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}
.exp-main {
  flex: 1 1 auto;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(330px, 420px) minmax(0, 1fr);
  grid-template-rows: minmax(0, 1fr);
  overflow: hidden;
}

/* LEFT — details column. Pinned nav on top, pinned actions on the bottom,
   the middle stats region is the only thing that scrolls (and only if the
   content overflows a normal desktop). */
.exp-details {
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: #fff;
  border-right: 1px solid #e2e8f0;
}
.exp-dialog--full .exp-nav {
  flex-shrink: 0;
  margin: 0;
  padding: 0.9rem 1.25rem;
  border-bottom: 1px solid #e2e8f0;
}
.exp-details-scroll {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 1.25rem;
}
.exp-dialog--full .exp-header { margin-bottom: 1.1rem; }
.exp-dialog--full .exp-actions {
  flex-shrink: 0;
  margin: 0;
  padding: 0.9rem 1.25rem;
  border-top: 1px solid #e2e8f0;
  background: #fff;
}

/* RIGHT — receipt pane. The image fills the column and is object-fit:contain
   so the whole receipt is always readable and never cropped. */
.exp-receipt-pane {
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding: 1.25rem;
  background: #f1f5f9;
  overflow: hidden;
}
.exp-receipt-label { flex-shrink: 0; margin-bottom: 0.85rem; }
.exp-receipt-imgwrap {
  flex: 1 1 auto;
  min-height: 0;
  position: relative; /* positioning context for the inline ZoomableImage */
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  padding: 0.75rem;
  border-radius: 10px;
  border: 1px solid #e2e8f0;
  background: #fff;
  box-shadow: 0 6px 20px rgba(15, 23, 42, 0.10);
}
.exp-dialog--full .exp-receipt-hint {
  flex-shrink: 0;
  text-align: center;
  margin-top: 0.6rem;
}
.exp-receipt-pdf-wrap {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
}
.exp-receipt-empty {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.75rem;
  color: #94a3b8;
  font-size: 0.9rem;
  font-weight: 600;
  border: 2px dashed #cbd5e1;
  border-radius: 12px;
  background: #f8fafc;
}
.exp-receipt-empty svg { color: #cbd5e1; }

/* Receipt Details — dynamic label/value list parsed from the receipt (left column). */
.exp-rd { margin-top: 0.9rem; }
.exp-rd-list {
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  background: #f8fafc;
  overflow: hidden;
}
.exp-rd-row {
  display: grid;
  grid-template-columns: minmax(0, 0.85fr) minmax(0, 1.15fr);
  gap: 0.75rem;
  align-items: baseline;
  padding: 0.5rem 0.75rem;
  border-top: 1px solid #eef2f7;
}
.exp-rd-row:first-child { border-top: none; }
.exp-rd-label {
  font-size: 0.72rem;
  font-weight: 600;
  color: #64748b;
  word-break: break-word;
}
.exp-rd-value {
  margin: 0;
  font-size: 0.82rem;
  font-weight: 600;
  color: #0f172a;
  text-align: right;
  word-break: break-word;
}
.exp-rd-empty {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 0.55rem;
  padding: 0.75rem;
  border: 1px dashed #cbd5e1;
  border-radius: 8px;
  background: #f8fafc;
}
.exp-rd-hint { margin: 0; font-size: 0.78rem; color: #64748b; line-height: 1.4; }
.exp-rd-extract {
  padding: 0.4rem 0.8rem;
  font-size: 0.74rem; font-weight: 600;
  background: var(--accent-dim); color: var(--accent);
  border: none; border-radius: 6px; cursor: pointer; font-family: inherit;
  transition: opacity 0.15s;
}
.exp-rd-extract:hover:not(:disabled) { opacity: 0.8; }
.exp-rd-extract:disabled { opacity: 0.5; cursor: not-allowed; }
.exp-rd-rescan {
  margin-top: 0.55rem;
  padding: 0;
  background: none; border: none;
  font-size: 0.72rem; font-weight: 600;
  color: var(--accent); cursor: pointer; font-family: inherit;
  text-decoration: underline; text-underline-offset: 2px;
  transition: opacity 0.15s;
}
.exp-rd-rescan:hover:not(:disabled) { opacity: 0.7; }
.exp-rd-rescan:disabled { opacity: 0.5; cursor: not-allowed; }

/* Below 820px a side-by-side split can't work — collapse to one column
   (details first, receipt below) and let the whole dialog scroll. */
@media (max-width: 820px) {
  .exp-dialog--full {
    display: block;
    overflow-y: auto;
    overflow-x: hidden;
    border-radius: 10px;
  }
  .exp-main { display: block; }
  .exp-details {
    border-right: none;
    border-bottom: 1px solid #e2e8f0;
  }
  .exp-details-scroll { overflow-y: visible; }
  .exp-receipt-pane { overflow: visible; min-height: 55vh; }
  .exp-receipt-imgwrap { flex: none; min-height: 46vh; }
}

/* Add Expense form */
.add-expense-card {
  background: var(--bg); border: 1px solid var(--border); border-radius: 10px;
  padding: 1rem; margin-bottom: 1rem;
}
.add-expense-title {
  font-size: 0.72rem; font-weight: 700; color: var(--text-dim);
  text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 0.6rem;
}
.add-expense-row {
  display: flex; gap: 0.5rem; margin-bottom: 0.5rem; flex-wrap: wrap; align-items: center;
}
.add-expense-row:last-child { margin-bottom: 0; }
.add-input {
  padding: 0.4rem 0.6rem; border: 1px solid var(--border); border-radius: 6px;
  font-family: inherit; font-size: 0.8rem; background: var(--surface); color: var(--text);
  min-width: 120px;
}
.add-input:focus { outline: none; border-color: var(--blue); }
/* Amber hint on an empty Gallons for a fuel receipt — it saves fine, it just
   won't contribute to cost-per-gallon or MPG. */
.add-input-warn { border-color: var(--amber, #f59e0b); }
.add-btn {
  padding: 0.4rem 1rem; font-size: 0.8rem; font-weight: 600; border-radius: 6px;
  border: none; background: var(--blue); color: #fff; cursor: pointer;
}
.add-btn:hover { opacity: 0.9; }
.add-btn:disabled { opacity: 0.5; cursor: default; }
.add-photo-label {
  display: inline-flex; align-items: center; gap: 0.5rem;
  font-size: 0.8rem; color: var(--text-dim);
}
.add-photo-input { font-size: 0.78rem; }
.add-photo-input:disabled { opacity: 0.5; cursor: default; }
.add-photo-preview { width: 64px; height: 48px; }
.add-photo-hint { font-size: 0.75rem; color: var(--text-dim); }
.add-photo-clear {
  padding: 0.25rem 0.55rem; font-size: 0.72rem;
  background: transparent; border: 1px solid var(--border); border-radius: 6px;
  color: var(--text-dim); cursor: pointer; font-family: inherit;
}
.add-photo-clear:hover { opacity: 0.75; }
.add-photo-clear:disabled { opacity: 0.5; cursor: default; }

/* Receipt OCR autofill status on the single Log Expense form */
.add-ocr-chip {
  display: inline-flex; align-items: center; gap: 0.4rem;
  padding: 0.2rem 0.55rem; font-size: 0.72rem; border-radius: 999px;
  background: rgba(34, 197, 94, 0.12); color: #16a34a;
  border: 1px solid rgba(34, 197, 94, 0.3);
}
.add-ocr-low { background: rgba(245, 158, 11, 0.12); color: #d97706; border-color: rgba(245, 158, 11, 0.3); }
.add-date-warn {
  display: inline-block; margin-left: 0.5rem; font-size: 0.75rem; font-weight: 600;
  color: var(--amber); background: var(--amber-dim); border: 1px solid var(--amber);
  border-radius: 6px; padding: 0.15rem 0.5rem;
}
.add-ocr-undo {
  background: transparent; border: none; padding: 0; cursor: pointer;
  font-family: inherit; font-size: 0.72rem; color: inherit;
  text-decoration: underline; opacity: 0.85;
}
.add-ocr-undo:hover { opacity: 1; }

/* Download Receipts (Super Admin) */
.download-receipts-card {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 1rem;
  margin-bottom: 1rem;
}
.download-receipts-title {
  display: flex; align-items: baseline; gap: 0.5rem; flex-wrap: wrap;
  font-size: 0.72rem; font-weight: 700; color: var(--text-dim);
  text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 0.6rem;
}
.download-receipts-hint {
  font-size: 0.68rem; font-weight: 500; text-transform: none;
  color: var(--text-dim); opacity: 0.7; letter-spacing: 0;
}
.download-receipts-row {
  display: flex; gap: 0.5rem; flex-wrap: wrap; align-items: center;
}
.download-receipts-error {
  margin-top: 0.5rem;
  font-size: 0.75rem;
  color: #b91c1c;
  background: #fef2f2;
  border: 1px solid #fecaca;
  padding: 0.4rem 0.6rem;
  border-radius: 6px;
}

/* ---- Mobile (≤ 767 px) ------------------------------------------------
 * Expense row gets a card layout. Download-ZIP + Log-Expense forms stack
 * vertically so inputs don't squish. Sub-tab strip becomes scrollable.
 * Detail modal (selectedExpense) already fits via the Teleport we shipped
 * earlier — no change needed there.                                       */
@media (max-width: 767px) {
  /* Fuel Logs section tables scroll sideways instead of crushing. The two
     review queues and the calibration readout are 5-6 columns; on a phone the
     alternative is a column of one-character-per-line text. Applies to the
     existing Monthly / Recent Fills tables too, which benefit the same way. */
  .section-card { overflow-x: auto; }
  .section-card table { min-width: 620px; }
  .cal-note { max-width: none; }

  /* Toggles stack rather than squeezing their counts onto a second line. */
  .fuel-review-bar { flex-direction: column; align-items: stretch; }
  .fuel-review-bar button { justify-content: center; }

  /* Scrollable sub-tabs (All / Fuel / Maintenance / IFTA) */
  .sub-tabs {
    overflow-x: auto;
    flex-wrap: nowrap;
    -webkit-overflow-scrolling: touch;
    scrollbar-width: none;
  }
  .sub-tabs::-webkit-scrollbar { display: none; }
  .sub-tab { flex-shrink: 0; }

  /* Download Receipts form — stack inputs */
  .download-receipts-row {
    flex-direction: column;
    align-items: stretch;
    gap: 0.5rem;
  }
  .download-receipts-row .add-input,
  .download-receipts-row .btn { max-width: none !important; width: 100%; }

  /* Log Expense form — stack all inputs; both rows become columns */
  .add-expense-row {
    flex-direction: column;
    align-items: stretch;
    gap: 0.5rem;
  }
  .add-expense-row .add-input,
  .add-expense-row .add-btn { max-width: none !important; width: 100%; flex: 1 1 auto; }

  /* Filter strip wraps instead of forcing a horizontal scroll */
  .filter-row { flex-wrap: wrap; gap: 0.5rem; }
  .filter-select { flex: 1; min-width: 120px; }
  .filter-count { width: 100%; }

  /* Mobile expense cards */
  .mobile-exp-list {
    display: flex;
    flex-direction: column;
    gap: 0.65rem;
    padding: 0.25rem 0;
  }
  .mobile-exp-card {
    background: #fff;
    border: 1px solid #e2e8f0;
    border-radius: 10px;
    padding: 0.85rem 0.95rem;
    display: flex;
    flex-direction: column;
    gap: 0.55rem;
    cursor: pointer;
    transition: border-color 0.15s;
  }
  .mobile-exp-card:active { border-color: #0f3460; }
  .mobile-exp-top {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 0.5rem;
  }
  .mobile-exp-select {
    display: flex; align-items: center;
    padding: 0.15rem 0.35rem 0.15rem 0; /* widen the tap target */
    flex-shrink: 0;
  }
  .mobile-exp-select .select-checkbox { width: 18px; height: 18px; }
  .mobile-exp-top-left { display: flex; flex-direction: column; gap: 0.15rem; min-width: 0; flex: 1; }
  .mobile-exp-date {
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    font-size: 0.75rem;
    color: #64748b;
  }
  /* Deliberately quieter than the receipt date: the purchase date is the figure
     that matters, the upload time is there to answer "when did this arrive". */
  .mobile-exp-uploaded {
    font-size: 0.68rem;
    color: #94a3b8;
    margin-top: 0.1rem;
  }
  .mobile-exp-driver {
    font-size: 0.92rem;
    font-weight: 600;
    color: #0f172a;
  }
  .mobile-exp-location {
    font-size: 0.78rem;
    color: #64748b;
  }
  .mobile-exp-vendor {
    font-size: 0.78rem;
    font-weight: 600;
    color: #475569;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .mobile-exp-truck {
    font-weight: 500;
    color: #64748b;
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.82rem;
  }
  .mobile-exp-desc {
    font-size: 0.82rem;
    color: #475569;
    line-height: 1.35;
    padding-top: 0.35rem;
    border-top: 1px solid #f1f5f9;
  }
  .mobile-exp-bottom {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 0.5rem;
    padding-top: 0.4rem;
    border-top: 1px solid #f1f5f9;
  }
  .mobile-exp-bottom-right {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-shrink: 0;
  }
  .mobile-exp-amount {
    font-size: 1.15rem;
    font-weight: 700;
    color: #0f172a;
  }
  .mobile-exp-thumb {
    width: 48px;
    height: 36px;
    object-fit: cover;
    border-radius: 4px;
    border: 1px solid #e2e8f0;
    cursor: pointer;
  }
  .mobile-exp-actions {
    display: flex;
    gap: 0.5rem;
    padding-top: 0.5rem;
    border-top: 1px solid #f1f5f9;
  }
  .mobile-exp-btn {
    flex: 1;
    padding: 0.6rem 0.75rem !important;
    font-size: 0.82rem !important;
    font-weight: 600;
  }
}
</style>
