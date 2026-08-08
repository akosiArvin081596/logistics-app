<template>
  <div class="data-manager admin-page">
    <!-- Sidebar sheet tabs (teleported) -->
    <SheetTabs
      :tabs="store.tabs"
      :current-sheet="store.currentSheet"
      @select="store.switchSheet"
    />

    <!-- Page header -->
    <div class="page-header">
      <h2>{{ store.currentSheet }}</h2>
      <div class="status-bar">
        <span class="status-pill">{{ store.total }} rows</span>
        <input
          class="search-input"
          type="text"
          placeholder="Search..."
          :value="store.searchQuery"
          @input="onSearch($event.target.value)"
        />
        <button
          v-if="store.currentSheet === 'Job Tracking' && store.duplicates.length > 0"
          :class="['btn', 'btn-dup', { active: store.showDuplicates }]"
          @click="store.showDuplicates = !store.showDuplicates"
        >Duplicate Records ({{ store.duplicates.length }})</button>
        <button class="btn btn-primary" @click="showModal = true">+ Add Row</button>
      </div>
    </div>

    <!-- Data Table -->
    <DataTable
      :headers="store.headers"
      :data="store.data"
      :editing-row="store.editingRow"
      :driver-list="store.driverList"
      :current-sheet="store.currentSheet"
      :user-role="auth.user?.role"
      @edit="handleEdit"
      @save="handleSave"
      @cancel="handleCancel"
      @delete="handleDelete"
    />

    <!-- Pagination -->
    <PaginationBar
      :page="store.page"
      :page-size="store.pageSize"
      :total="store.total"
      :total-pages="store.totalPages"
      @go="store.setPage"
      @size="store.setPageSize"
    />

    <!-- Duplicate Records Section -->
    <div v-if="store.showDuplicates && sortedDuplicates.length > 0" class="duplicates-section">
      <div class="duplicates-header">
        <h3>Duplicate Records</h3>
        <span class="dup-count">{{ sortedDuplicates.length }} records with duplicate Load IDs</span>
      </div>
      <div class="duplicates-body">
        <DataTable
          :headers="store.headers"
          :data="sortedDuplicates"
          :editing-row="null"
          :driver-list="store.driverList"
          :current-sheet="store.currentSheet"
          :user-role="auth.user?.role"
          @edit="handleEdit"
          @save="handleSave"
          @cancel="handleCancel"
          @delete="handleDelete"
        />
      </div>
    </div>

    <!-- Add Row Modal -->
    <AddRowModal
      :headers="store.headers"
      :driver-list="store.driverList"
      :current-sheet="store.currentSheet"
      :open="showModal"
      @submit="handleAdd"
      @close="showModal = false"
    />

    <!-- Delete Confirmation. The reason is REQUIRED by the server and is stored
         in the audit trail with the row's contents — this delete removes the row
         from the sheet permanently and shifts every row below it up. -->
    <ConfirmModal
      :open="deleteTarget !== null"
      title="Delete Row"
      :message="`Row ${deleteTarget} of &quot;${store.currentSheet}&quot; will be permanently removed from the sheet and every row below it shifts up. This cannot be undone.`"
      confirm-text="Delete"
      :danger="true"
      :confirm-disabled="deleteReason.trim().length < 3 || deleting"
      @confirm="confirmDelete"
      @cancel="cancelDelete"
    >
      <label class="reason-label" for="delete-reason">Reason (recorded in the audit trail)</label>
      <textarea
        id="delete-reason"
        v-model="deleteReason"
        class="reason-input"
        rows="2"
        placeholder="e.g. duplicate of row 118 created by a re-sent rate con"
      />
      <p v-if="deleteError" class="reason-error">{{ deleteError }}</p>
    </ConfirmModal>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useSheetsStore } from '../stores/sheets'
import { useAuthStore } from '../stores/auth'
import { useToast } from '../composables/useToast'
import { useSocket } from '../composables/useSocket'
import SheetTabs from '../components/data-manager/SheetTabs.vue'
import DataTable from '../components/data-manager/DataTable.vue'
import AddRowModal from '../components/data-manager/AddRowModal.vue'
import PaginationBar from '../components/shared/PaginationBar.vue'
import ConfirmModal from '../components/shared/ConfirmModal.vue'

const store = useSheetsStore()
const auth = useAuthStore()
const { show: toast } = useToast()
const socket = useSocket()

const showModal = ref(false)
const deleteTarget = ref(null)
const deleteReason = ref('')
const deleteError = ref('')
const deleting = ref(false)
let searchTimer = null

// Sort duplicates by Load ID so matching rows are grouped together
const sortedDuplicates = computed(() => {
  const dups = store.duplicates || []
  if (dups.length === 0) return []
  const loadIdCol = store.headers.find(h => /load.?id|job.?id/i.test(h))
  if (!loadIdCol) return dups
  return [...dups].sort((a, b) => {
    const aId = (a[loadIdCol] || '').replace(/^#/, '').trim()
    const bId = (b[loadIdCol] || '').replace(/^#/, '').trim()
    return aId.localeCompare(bId) || (a._rowIndex || 0) - (b._rowIndex || 0)
  })
})

function onSearch(value) {
  store.searchQuery = value
  clearTimeout(searchTimer)
  searchTimer = setTimeout(() => store.setSearch(value), 300)
}

function onStatusUpdated(payload) {
  toast(`${payload.driverName} updated Load ${payload.loadId} to "${payload.newStatus}"`, 'success')
  store.loadData()
}

function onLoadAssigned(payload) {
  toast(`Load ${payload.loadId || ''} assigned to ${payload.driverName || 'driver'}`, 'success')
  store.loadData()
}

function onPodUploaded(payload) {
  toast(`POD uploaded for Load ${payload.loadId || ''}`, 'success')
  store.loadData()
}

onMounted(async () => {
  try {
    await Promise.all([store.loadTabs(), store.loadDrivers()])
    await store.loadData()
  } catch {
    toast('Failed to load data', 'error')
  }

  socket.connect()
  socket.register('dispatch')
  socket.on('status-updated', onStatusUpdated)
  socket.on('load-assigned', onLoadAssigned)
  socket.on('pod-uploaded', onPodUploaded)
})

onUnmounted(() => {
  socket.off('status-updated', onStatusUpdated)
  socket.off('load-assigned', onLoadAssigned)
  socket.off('pod-uploaded', onPodUploaded)
})

function handleEdit(rowIndex) {
  store.editingRow = rowIndex
}

function handleCancel() {
  store.editingRow = null
}

async function handleSave(rowIndex, values) {
  try {
    await store.saveRow(rowIndex, values)
    toast('Row updated', 'success')
  } catch {
    toast('Failed to update row', 'error')
  }
}

async function handleAdd(values) {
  try {
    const result = await store.addRow(values)
    showModal.value = false
    if (result?.warning) {
      toast(result.warning, 'error')
    } else {
      toast('Row added successfully', 'success')
    }
  } catch {
    toast('Failed to add row', 'error')
  }
}

function handleDelete(rowIndex) {
  deleteTarget.value = rowIndex
  deleteReason.value = ''
  deleteError.value = ''
}

function cancelDelete() {
  deleteTarget.value = null
  deleteReason.value = ''
  deleteError.value = ''
}

async function confirmDelete() {
  const rowIndex = deleteTarget.value
  const reason = deleteReason.value.trim()
  if (rowIndex === null || reason.length < 3 || deleting.value) return
  deleting.value = true
  deleteError.value = ''
  try {
    await store.deleteRow(rowIndex, reason)
    cancelDelete()
    toast('Row deleted', 'success')
  } catch (err) {
    // Keep the modal open and show what the server actually said. A row in a
    // finalized month comes back as 409 PERIOD_FINALIZED naming the month and
    // pointing at the reversible soft delete; collapsing that to "Failed to
    // delete row" throws away the only actionable part of the response.
    deleteError.value = (err && err.message) || 'Failed to delete row.'
  } finally {
    deleting.value = false
  }
}
</script>

<style scoped>
.status-pill { text-transform: uppercase; letter-spacing: 0.03em; font-weight: 600; font-size: 0.7rem; }
.search-input {
  padding: 0.4rem 0.7rem;
  border: 1px solid var(--border);
  border-radius: 6px;
  font-family: inherit;
  font-size: 0.82rem;
  background: var(--surface);
  color: var(--text);
  min-width: 180px;
  outline: none;
  transition: border-color 0.15s;
}
.search-input:focus { border-color: var(--accent); }
.search-input::placeholder { color: var(--text-dim); }
:deep(.pagination) { border-radius: 0 0 var(--radius) var(--radius); }

.btn-dup {
  padding: 0.4rem 0.8rem;
  font-size: 0.75rem;
  font-weight: 600;
  border: 1px solid var(--amber);
  border-radius: 6px;
  background: var(--surface);
  color: var(--amber);
  cursor: pointer;
  font-family: inherit;
  transition: all 0.15s;
}
.btn-dup:hover, .btn-dup.active {
  background: var(--amber-dim);
}

.duplicates-section {
  margin-top: 1.5rem;
  border: 2px solid var(--amber);
  border-radius: var(--radius);
  overflow: hidden;
}
.duplicates-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.85rem 1.25rem;
  background: var(--amber-dim);
  border-bottom: 1px solid var(--amber);
}
.duplicates-header h3 {
  font-size: 0.95rem;
  font-weight: 700;
  margin: 0;
  color: var(--text);
}
.dup-count {
  font-size: 0.72rem;
  font-weight: 600;
  padding: 0.25rem 0.65rem;
  border-radius: 8px;
  background: var(--amber);
  color: #fff;
}
.duplicates-body {
  max-height: 500px;
  overflow-y: auto;
  background: var(--surface);
}

/* Delete-confirm reason field. Matches the cancel-load reason in ActiveLoadsTab:
   deliberately plain so it inherits the confirm dialog's surface rather than the
   data table's dense styling. */
.reason-label {
  display: block;
  font-size: 0.8rem;
  font-weight: 600;
  color: var(--text);
}
.reason-input {
  display: block;
  width: 100%;
  margin-top: 0.35rem;
  padding: 0.5rem 0.6rem;
  font-size: 0.85rem;
  font-family: inherit;
  border: 1px solid var(--border, #e2e8f0);
  border-radius: 8px;
  background: var(--bg, #fff);
  color: inherit;
}
.reason-input:focus {
  outline: none;
  border-color: #94a3b8;
}
.reason-error {
  margin: 0.5rem 0 0;
  font-size: 0.8rem;
  color: var(--red, #dc2626);
}
</style>
