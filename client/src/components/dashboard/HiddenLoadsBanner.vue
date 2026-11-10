<template>
  <div v-if="hiddenLoads.length" class="hidden-loads" role="status">
    <div v-for="h in hiddenLoads" :key="h.tombstoneId" class="hl-line">
      <svg class="hl-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" /></svg>
      <span class="hl-text">{{ hiddenLoadText(h, fmtAppInstant(h.deletedAt)) }}</span>
      <button type="button" class="hl-review" @click="current = h">Review</button>
    </div>
    <DeletedLoadChoiceModal :open="!!current" :choice="choice" review @resolved="onResolved" @cancel="current = null" />
  </div>
</template>

<script setup>
import { computed, ref } from 'vue'
import { useToast } from '../../composables/useToast'
import { fmtAppInstant } from '../../utils/datetime'
import { hiddenLoadChoice, hiddenLoadText, restoreDoneText } from '../../lib/deletedLoadsView.js'
import DeletedLoadChoiceModal from '../shared/DeletedLoadChoiceModal.vue'

// A Super Admin's live rows an old delete hides (GET /api/dashboard's hiddenLoads; the
// dashboard renders this for a Super Admin only). Review opens the shared choice, both on.
defineProps({ hiddenLoads: { type: Array, default: () => [] } })
const emit = defineEmits(['resolved'])
const { show: toast } = useToast()
const current = ref(null)
const choice = computed(() => (current.value ? hiddenLoadChoice(current.value) : null))

function onResolved(answer) {
  const h = current.value
  current.value = null
  toast(restoreDoneText(answer, h && h.loadId), 'success')
  emit('resolved')
}
</script>

<style scoped>
.hidden-loads {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  margin-bottom: 1rem;
  padding: 0.7rem 0.9rem;
  border: 1px solid #fde68a;
  border-radius: 10px;
  background: #fffbeb;
  color: #92400e;
}
.hl-line {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  min-width: 0;
  font-size: 0.85rem;
}
.hl-icon { flex-shrink: 0; }
.hl-text { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.hl-review {
  flex-shrink: 0;
  min-height: 2rem;
  padding: 0.3rem 0.8rem;
  border: 1px solid #f59e0b;
  border-radius: 6px;
  background: #fff;
  color: #92400e;
  font-family: inherit;
  font-size: 0.8rem;
  font-weight: 600;
  cursor: pointer;
}
.hl-review:hover, .hl-review:focus-visible { background: #fef3c7; }
@media (max-width: 640px) {
  .hl-line { flex-wrap: wrap; }
  .hl-review { margin-left: auto; }
}
</style>
