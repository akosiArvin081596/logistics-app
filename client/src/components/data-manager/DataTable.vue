<template>
  <div class="table-wrapper">
    <table>
      <thead>
        <tr>
          <!-- Keyed by position: a tab can repeat a header name, blank included. -->
          <th v-for="(h, i) in headers" :key="i">{{ h }}</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in data" :key="row._rowIndex">
          <!-- Data cells. An input edits its column by position (editValues[i]). -->
          <td v-for="(h, i) in headers" :key="i">
            <template v-if="isEditing(row)">
              <!-- Driver column: render select -->
              <select
                v-if="isDriverField(h) && driverList.length && props.currentSheet !== 'Carrier Database'"
                :data-header="h"
                :value="editValues[i]"
                @input="editValues[i] = $event.target.value"
              >
                <option value="">Select driver</option>
                <option v-for="d in driverList" :key="d" :value="d">{{ d }}</option>
              </select>
              <!-- Other columns: render input -->
              <input
                v-else
                :data-header="h"
                :value="editValues[i]"
                @input="editValues[i] = $event.target.value"
              />
            </template>
            <template v-else>{{ displayCell(row[h]) }}</template>
          </td>

          <!-- Action buttons -->
          <td class="actions">
            <template v-if="isEditing(row)">
              <button class="btn btn-primary btn-sm" @click="handleSave(row._rowIndex)">Save</button>
              <button class="btn btn-secondary btn-sm" @click="$emit('cancel')">Cancel</button>
            </template>
            <template v-else>
              <button class="btn btn-secondary btn-sm" @click="handleEdit(row)">Edit</button>
              <button
                v-if="userRole === 'Super Admin'"
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
import { ref, watch } from 'vue'
import { openRowEdit, rowEditBody } from '../../lib/rowEdit'

const props = defineProps({
  headers: { type: Array, required: true },
  data: { type: Array, required: true },
  editingRow: { type: Number, default: null },
  driverList: { type: Array, default: () => [] },
  currentSheet: { type: String, default: '' },
  userRole: { type: String, default: '' },
})

// `save` carries (rowIndex, values, baseline, headers): the inputs' values and
// the row's values as the edit opened them, one per column of `headers`, the
// columns the edit opened with (lib/rowEdit.js).
const emit = defineEmits(['edit', 'save', 'cancel', 'delete'])

// The open edit (openRowEdit()): the row number it opened on, the headers, and
// `baseline`. Taken when the edit opens and kept through the table's live
// reloads, which can put another row under the same row number; never rebuilt
// from `data`, where it would be the new row compared with itself.
const edit = ref(null)
// The inputs' values, one per column by position, starting as the baseline.
const editValues = ref([])

// The row this table's edit is open on. A row number set from elsewhere (the
// duplicates table's Edit) opens no inputs here: they were never filled from
// that row.
function isEditing(row) {
  return props.editingRow === row._rowIndex && !!edit.value && edit.value.rowIndex === row._rowIndex
}

function isDriverField(headerName) {
  return /^driver$/i.test(headerName.trim())
}

function displayCell(val) {
  if (!val || typeof val !== 'string' || val[0] !== '{') return val || ''
  try {
    const parsed = JSON.parse(val)
    return Object.values(parsed).filter(Boolean).join(' \u2022 ')
  } catch {
    return val
  }
}

function handleEdit(row) {
  edit.value = openRowEdit(props.headers, row)
  editValues.value = edit.value.baseline.slice()
  emit('edit', row._rowIndex)
}

function handleSave(rowIndex) {
  const body = rowEditBody(edit.value, rowIndex, editValues.value)
  if (!body) return
  emit('save', rowIndex, body.values, body.baseline, edit.value.headers.slice())
}

// The edit ends when the page moves off its row: a save, Cancel, a page, tab
// or search change (editingRow null), or an Edit elsewhere.
watch(
  () => props.editingRow,
  (rowIndex) => {
    if (edit.value && edit.value.rowIndex !== rowIndex) {
      edit.value = null
      editValues.value = []
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
