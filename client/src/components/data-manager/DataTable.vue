<template>
  <div class="table-wrapper">
    <table>
      <thead>
        <tr>
          <th v-for="h in headers" :key="h">{{ h }}</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in data" :key="row._rowIndex">
          <!-- Data cells -->
          <td v-for="h in headers" :key="h">
            <template v-if="editingRow === row._rowIndex">
              <!-- Driver column: render select -->
              <select
                v-if="isDriverField(h) && driverList.length"
                :data-header="h"
                :value="editValues[h]"
                @input="editValues[h] = $event.target.value"
              >
                <option value="">Select driver</option>
                <option v-for="d in driverList" :key="d" :value="d">{{ d }}</option>
              </select>
              <!-- Other columns: render input -->
              <input
                v-else
                :data-header="h"
                :value="editValues[h]"
                @input="editValues[h] = $event.target.value"
              />
            </template>
            <template v-else>{{ row[h] }}</template>
          </td>

          <!-- Action buttons -->
          <td class="actions">
            <template v-if="editingRow === row._rowIndex">
              <button class="btn btn-primary btn-sm" @click="handleSave(row._rowIndex)">Save</button>
              <button class="btn btn-secondary btn-sm" @click="$emit('cancel')">Cancel</button>
            </template>
            <template v-else>
              <button class="btn btn-secondary btn-sm" @click="handleEdit(row)">Edit</button>
              <button
                v-if="userRole === 'Admin'"
                class="btn btn-danger btn-sm"
                @click="$emit('delete', row._rowIndex)"
              >Delete</button>
            </template>
          </td>
        </tr>
      </tbody>
    </table>

    <div v-if="!data.length" class="empty-state">
      No data yet. Add your first row above!
    </div>
  </div>
</template>

<script setup>
import { reactive, watch } from 'vue'

const props = defineProps({
  headers: { type: Array, required: true },
  data: { type: Array, required: true },
  editingRow: { type: Number, default: null },
  driverList: { type: Array, default: () => [] },
  userRole: { type: String, default: '' },
})

const emit = defineEmits(['edit', 'save', 'cancel', 'delete'])

const editValues = reactive({})

function isDriverField(headerName) {
  return /^driver$/i.test(headerName.trim())
}

function handleEdit(row) {
  // Pre-populate edit values from the row data
  props.headers.forEach((h) => {
    editValues[h] = row[h] || ''
  })
  emit('edit', row._rowIndex)
}

function handleSave(rowIndex) {
  const values = props.headers.map((h) => editValues[h] || '')
  emit('save', rowIndex, values)
}

// Reset edit values when editingRow changes externally (e.g., cancel)
watch(
  () => props.editingRow,
  (newVal) => {
    if (newVal === null) {
      props.headers.forEach((h) => {
        editValues[h] = ''
      })
    }
  }
)
</script>

<style scoped>
.table-wrapper {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow: auto;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.04);
  flex: 1;
  min-height: 0;
}
table {
  width: 100%;
  border-collapse: collapse;
}
thead {
  background: var(--surface-hover);
  position: sticky;
  top: 0;
  z-index: 1;
}
th {
  padding: 0.75rem 1rem;
  text-align: left;
  font-size: 0.72rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-dim);
  border-bottom: 1px solid var(--border);
  white-space: nowrap;
}
td {
  padding: 0.7rem 1rem;
  font-size: 0.88rem;
  border-bottom: 1px solid var(--border);
}
tr:last-child td {
  border-bottom: none;
}
tr:hover td {
  background: var(--surface-hover);
}
td.actions {
  white-space: nowrap;
  display: flex;
  gap: 0.4rem;
}
td input {
  width: 100%;
  padding: 0.3rem 0.5rem;
  background: var(--surface);
  border: 1px solid var(--accent);
  border-radius: 4px;
  color: var(--text);
  font-family: 'DM Sans', sans-serif;
  font-size: 0.88rem;
  outline: none;
}
td select {
  width: 100%;
  padding: 0.3rem 0.5rem;
  background: var(--surface);
  border: 1px solid var(--accent);
  border-radius: 4px;
  color: var(--text);
  font-family: 'DM Sans', sans-serif;
  font-size: 0.88rem;
  outline: none;
}
.empty-state {
  text-align: center;
  padding: 3rem 1rem;
  color: var(--text-dim);
  font-size: 0.85rem;
}
</style>
