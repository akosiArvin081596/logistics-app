<template>
  <div class="data-manager">
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
        <button class="btn btn-primary" @click="showModal = true">+ Add Row</button>
      </div>
    </div>

    <!-- Data Table -->
    <DataTable
      :headers="store.headers"
      :data="store.data"
      :editing-row="store.editingRow"
      :driver-list="store.driverList"
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

    <!-- Add Row Modal -->
    <AddRowModal
      :headers="store.headers"
      :driver-list="store.driverList"
      :open="showModal"
      @submit="handleAdd"
      @close="showModal = false"
    />

    <!-- Delete Confirmation -->
    <ConfirmModal
      :open="deleteTarget !== null"
      title="Delete Row"
      message="Are you sure you want to delete this row? This action cannot be undone."
      confirm-text="Delete"
      :danger="true"
      @confirm="confirmDelete"
      @cancel="deleteTarget = null"
    />
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { useSheetsStore } from '../stores/sheets'
import { useAuthStore } from '../stores/auth'
import { useToast } from '../composables/useToast'
import SheetTabs from '../components/data-manager/SheetTabs.vue'
import DataTable from '../components/data-manager/DataTable.vue'
import AddRowModal from '../components/data-manager/AddRowModal.vue'
import PaginationBar from '../components/shared/PaginationBar.vue'
import ConfirmModal from '../components/shared/ConfirmModal.vue'

const store = useSheetsStore()
const auth = useAuthStore()
const { show: toast } = useToast()

const showModal = ref(false)
const deleteTarget = ref(null)

onMounted(async () => {
  try {
    await Promise.all([store.loadTabs(), store.loadDrivers()])
    await store.loadData()
  } catch {
    toast('Failed to load data', 'error')
  }
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
    await store.addRow(values)
    showModal.value = false
    toast('Row added successfully', 'success')
  } catch {
    toast('Failed to add row', 'error')
  }
}

function handleDelete(rowIndex) {
  deleteTarget.value = rowIndex
}

async function confirmDelete() {
  const rowIndex = deleteTarget.value
  deleteTarget.value = null
  try {
    await store.deleteRow(rowIndex)
    toast('Row deleted', 'success')
  } catch {
    toast('Failed to delete row', 'error')
  }
}
</script>

<style scoped>
.status-bar {
  display: flex;
  gap: 0.75rem;
  flex-wrap: wrap;
  align-items: center;
}
.status-pill {
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.7rem;
  padding: 0.25rem 0.75rem;
  border-radius: 20px;
  background: var(--surface);
  border: 1px solid var(--border);
  color: var(--text-dim);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.03em;
}

/* Pagination styles */
:deep(.pagination) {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.75rem 1rem;
  border-top: 1px solid var(--border);
  background: var(--surface);
  border-radius: 0 0 var(--radius) var(--radius);
  flex-wrap: wrap;
  gap: 0.5rem;
}
:deep(.pagination-info) {
  font-size: 0.78rem;
  color: var(--text-dim);
  font-family: 'JetBrains Mono', monospace;
}
:deep(.pagination-controls) {
  display: flex;
  align-items: center;
  gap: 0.25rem;
}
:deep(.page-btn) {
  min-width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface);
  color: var(--text-dim);
  font-family: 'DM Sans', sans-serif;
  font-size: 0.8rem;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.12s;
}
:deep(.page-btn:hover:not(:disabled)) {
  background: var(--surface-hover);
  color: var(--text);
  border-color: var(--text-dim);
}
:deep(.page-btn.active) {
  background: var(--accent);
  color: #fff;
  border-color: var(--accent);
}
:deep(.page-btn:disabled) {
  opacity: 0.4;
  cursor: not-allowed;
}
:deep(.page-size-select) {
  padding: 0.3rem 0.5rem;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface);
  color: var(--text);
  font-family: 'DM Sans', sans-serif;
  font-size: 0.78rem;
  cursor: pointer;
  outline: none;
  margin-left: 0.5rem;
}
</style>
