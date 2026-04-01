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
    <div v-if="store.showDuplicates && store.duplicates.length > 0" class="duplicates-section">
      <div class="duplicates-header">
        <h3>Duplicate Records</h3>
        <span class="dup-count">{{ store.duplicates.length }} stale</span>
      </div>
      <DataTable
        :headers="store.headers"
        :data="store.duplicates"
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

    <!-- Add Row Modal -->
    <AddRowModal
      :headers="store.headers"
      :driver-list="store.driverList"
      :current-sheet="store.currentSheet"
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
import { ref, onMounted, onUnmounted } from 'vue'
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
let searchTimer = null

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
  margin-top: 1.25rem;
  border: 2px solid var(--amber);
  border-radius: var(--radius);
  overflow: hidden;
}
.duplicates-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.75rem 1rem;
  background: var(--amber-dim);
}
.duplicates-header h3 {
  font-size: 0.9rem;
  font-weight: 700;
  margin: 0;
}
.dup-count {
  font-size: 0.7rem;
  font-weight: 600;
  padding: 0.2rem 0.5rem;
  border-radius: 8px;
  background: var(--amber);
  color: #fff;
}
</style>
