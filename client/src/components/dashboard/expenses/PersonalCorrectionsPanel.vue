<template>
  <!-- Personal lines waiting for a correction invoice (R3 v1), Super Admin only:
       one row per driver and week, as the server groups them, with Create. With
       the receipt's week on the server sends `carried` instead: one row per line
       waiting for the driver's next weekly invoice, nothing to create. Hidden
       when nothing waits. Every figure is the server's text. -->
  <div v-if="carried.length" class="personal-corrections personal-carried" role="region" aria-label="Personal lines waiting for the next weekly invoice">
    <div class="pc-title">Personal lines waiting for the next weekly invoice</div>
    <p class="pc-note">Each goes on the driver's next weekly invoice with room, oldest first.</p>
    <ul class="pc-list">
      <li v-for="c in carried" :key="c.line_id" class="pc-row">
        <span class="pc-what">{{ c.driver }} · since {{ c.since_label }} · {{ c.amount_text }} · {{ c.reason }}</span>
      </li>
    </ul>
  </div>
  <div v-else-if="groups.length" class="personal-corrections" role="region" aria-label="Personal lines waiting for a correction invoice">
    <div class="pc-title">Personal lines waiting for a correction invoice</div>
    <p class="pc-note">These weeks had no weekly invoice that could still take the line. Create the week's correction invoice; it opens as a Draft for approval.</p>
    <ul class="pc-list">
      <li v-for="g in groups" :key="`${g.driver}|${g.week_start}`" class="pc-row">
        <span class="pc-what">{{ g.driver }} · week of {{ g.week_label }} · {{ g.lines }} line{{ g.lines === 1 ? '' : 's' }}, {{ g.amount_text }}</span>
        <button type="button" class="pc-create" :disabled="busyKey !== ''" @click="create(g)">
          {{ busyKey === `${g.driver}|${g.week_start}` ? 'Creating…' : 'Create correction invoice' }}
        </button>
      </li>
    </ul>
  </div>
</template>

<script setup>
import { onMounted, ref } from 'vue'
import { useApi } from '../../../composables/useApi'
import { useToast } from '../../../composables/useToast'
import { useSocketRefresh } from '../../../composables/useSocketRefresh'

const api = useApi()
const { show: toast } = useToast()
const groups = ref([])
const carried = ref([])
const busyKey = ref('')

async function load() {
  try {
    const data = await api.get('/api/expenses/personal/waiting-corrections')
    groups.value = Array.isArray(data.groups) ? data.groups : []
    carried.value = Array.isArray(data.carried) ? data.carried : []
  } catch {
    groups.value = []
    carried.value = []
  }
}

async function create(g) {
  if (busyKey.value) return
  busyKey.value = `${g.driver}|${g.week_start}`
  try {
    const res = await api.post('/api/invoices/personal-corrections', { driver: g.driver, weekStart: g.week_start }, { timeout: 60000 })
    toast(res.invoice && res.invoice.invoice_number ? `Correction ${res.invoice.invoice_number} created as a Draft` : 'Correction invoice created', 'success')
    await load()
  } catch (err) {
    toast((err && err.message) || 'The correction invoice was not created', 'error')
  } finally {
    busyKey.value = ''
  }
}

onMounted(load)
useSocketRefresh('expenses:changed', load)
useSocketRefresh('invoices:changed', load)
</script>

<style scoped>
.personal-corrections {
  margin: 0 0 0.9rem;
  padding: 0.75rem 0.9rem;
  border: 1px solid #fca5a5;
  border-radius: 8px;
  background: #fef2f2;
}
.pc-title { font-weight: 700; font-size: 0.85rem; color: #991b1b; }
.pc-note { margin: 0.25rem 0 0.5rem; font-size: 0.78rem; color: #7f1d1d; }
.pc-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.4rem; }
.pc-row { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 0.5rem; font-size: 0.8rem; }
.pc-create {
  padding: 0.25rem 0.7rem;
  border-radius: 6px;
  border: 1px solid #b91c1c;
  background: #fff;
  color: #991b1b;
  font-weight: 600;
  font-size: 0.75rem;
  cursor: pointer;
}
.pc-create:disabled { opacity: 0.5; cursor: default; }
.personal-carried { border-color: #c7d2fe; background: #eef2ff; }
.personal-carried .pc-title,
.personal-carried .pc-note { color: #3730a3; }
</style>
