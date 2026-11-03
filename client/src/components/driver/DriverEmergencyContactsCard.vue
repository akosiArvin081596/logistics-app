<template>
  <!-- The driver's own emergency contacts in the Kit tab. DriverView renders it only
       for a Driver whose payload carries the counts (EMERGENCY_CONTACTS_ENABLED);
       the list comes from his own route and lives in this card alone. -->
  <section class="card eck-card" :aria-labelledby="titleId" data-testid="ec-kit-card">
    <div class="eck-header">
      <div class="eck-icon" aria-hidden="true">&#128222;</div>
      <h3 :id="titleId" class="eck-title">Emergency contacts</h3>
    </div>

    <p v-if="loading" class="eck-empty">Loading&hellip;</p>
    <p v-else-if="loadError" class="eck-empty" role="alert">{{ loadError }}</p>
    <template v-else>
      <ul v-if="lines.length" class="eck-list">
        <li v-for="line in lines" :key="line.id ?? line.phone" class="eck-row" data-testid="ec-kit-row">
          <span class="eck-who">
            <span class="eck-name">{{ line.name }}</span>
            <span v-if="line.primary" class="eck-tag">Primary</span>
            <span class="eck-rel">{{ line.relationship }}</span>
          </span>
          <a v-if="line.tel" :href="line.tel" class="eck-phone">{{ line.phone }}</a>
          <span v-else class="eck-phone">{{ line.phone }}</span>
        </li>
      </ul>
      <p v-else class="eck-empty" data-testid="ec-kit-empty">No emergency contacts yet. Add at least two.</p>
      <p v-if="lines.length && lines.length < MIN_CONTACTS" class="eck-hint">{{ MESSAGES.EMERGENCY_CONTACTS_MIN }}</p>
    </template>

    <button type="button" class="eck-btn" data-testid="ec-kit-edit" @click="emit('edit')">{{ lines.length ? 'Edit' : 'Add' }} emergency contacts</button>
  </section>
</template>

<script setup>
import { computed, onUnmounted, ref, useId, watch } from 'vue'
import { useApi } from '../../composables/useApi'
import { CONTACTS_URL, MESSAGES, MIN_CONTACTS, contactLines, refusalText } from '../../lib/emergencyContacts'

// `revision` moves on after each save in the form, so the card reads the list again.
const props = defineProps({
  revision: { type: Number, default: 0 },
})
const emit = defineEmits(['edit'])

const api = useApi()
const titleId = useId()
// Here only, never the store or the browser's storage: a shared phone never shows
// the previous driver's contacts.
const contacts = ref([])
const loading = ref(false)
const loadError = ref('')
let seq = 0

const lines = computed(() => contactLines(contacts.value))

async function load() {
  const mine = ++seq
  loading.value = true
  loadError.value = ''
  try {
    const answer = await api.get(CONTACTS_URL)
    if (mine !== seq) return
    contacts.value = answer && Array.isArray(answer.contacts) ? answer.contacts : []
  } catch (err) {
    if (mine !== seq) return
    contacts.value = []
    loadError.value = refusalText(err, 'READ_FAILED')
  } finally {
    if (mine === seq) loading.value = false
  }
}

watch(() => props.revision, load, { immediate: true })
onUnmounted(() => { seq++; contacts.value = [] })
</script>

<style scoped>
.eck-card { margin-top: 1rem; }
.eck-header { display: flex; align-items: center; gap: 0.65rem; margin-bottom: 0.75rem; }
.eck-icon {
  width: 32px; height: 32px; border-radius: 8px; background: var(--accent-dim); color: var(--accent);
  display: flex; align-items: center; justify-content: center; font-size: 1rem; flex-shrink: 0;
}
.eck-title { font-size: 0.95rem; font-weight: 700; margin: 0; }
.eck-list { list-style: none; margin: 0 0 0.75rem; padding: 0; display: flex; flex-direction: column; gap: 0.5rem; }
.eck-row {
  display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 0.35rem 0.75rem;
  padding: 0.7rem 0.85rem; background: var(--bg); border: 1px solid var(--border); border-radius: 10px; min-width: 0;
}
.eck-who { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.25rem 0.5rem; min-width: 0; }
.eck-name { font-size: 0.9rem; font-weight: 600; color: var(--text); overflow-wrap: anywhere; }
.eck-tag {
  font-size: 0.68rem; font-weight: 700; padding: 0.1rem 0.5rem; border-radius: 12px;
  background: var(--accent-dim); color: #0369a1; white-space: nowrap;
}
.eck-rel { font-size: 0.8rem; color: var(--text-dim); overflow-wrap: anywhere; }
/* A number is a tap to call: a 44 px target. */
.eck-phone {
  display: inline-flex; align-items: center; min-height: 44px; font-size: 0.9rem; font-weight: 600;
  color: #0369a1; text-decoration: none; white-space: nowrap;
}
.eck-empty, .eck-hint { font-size: 0.85rem; color: var(--text-dim); margin: 0 0 0.75rem; }
.eck-btn {
  display: flex; align-items: center; justify-content: center; width: 100%; min-height: 44px;
  padding: 0.5rem 0.75rem; border: 1px solid var(--accent); border-radius: var(--radius, 8px);
  background: transparent; color: #0369a1; font-family: inherit; font-size: 0.85rem; font-weight: 600; cursor: pointer;
}
.eck-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
@media (min-width: 768px) {
  .eck-btn { width: auto; padding: 0.5rem 1.25rem; }
}
</style>
