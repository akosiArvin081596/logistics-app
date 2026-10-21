<!--
  One driver-instructions payload as the server sent it: the whole-load
  requirements, then each stop (kind, facility, place, references, requirements,
  instructions), then the footnote. Display only: it shows every item it is
  given, in order, and works nothing out. With `showFlags`, an item the server
  marked with a `flag` (another address, redirect wording, no category, text
  that reads like instructions to a computer) carries a "Hidden from drivers"
  tag; the driver preview never holds such an item.
-->
<template>
  <div class="di-payload space-y-2 text-sm">
    <p v-if="empty" class="text-xs text-gray-500">No instructions for drivers.</p>
    <div v-if="loadRequirements.length">
      <h5 class="text-[0.7rem] font-semibold uppercase tracking-wide text-gray-500">Whole load</h5>
      <ul class="mt-1 space-y-1">
        <li v-for="(r, i) in loadRequirements" :key="`lr-${i}`" class="break-words">
          <span class="font-semibold" :class="r.critical ? 'text-red-700' : 'text-gray-800'">{{ categoryLabel(r.category) }}:</span>
          {{ r.text }}
          <span v-if="showFlags && r.flag" class="di-flag" :title="whyHidden(r)">Hidden from drivers</span>
        </li>
      </ul>
    </div>
    <div v-for="(s, si) in stops" :key="`stop-${si}`" class="rounded-md border border-gray-200 p-2">
      <p class="font-semibold text-gray-900">
        Stop {{ si + 1 }} · {{ stopKindLabel(s.kind) }}<template v-if="s.facility"> · {{ s.facility }}</template>
        <span v-if="s.place" class="font-normal text-gray-600"> ({{ s.place }})</span>
      </p>
      <dl v-if="list(s.references).length" class="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
        <template v-for="(ref, ri) in list(s.references)" :key="`ref-${si}-${ri}`">
          <dt class="text-gray-500">{{ referenceLabel(ref) }}</dt>
          <dd class="break-all font-mono text-gray-900">{{ ref.value }}</dd>
        </template>
      </dl>
      <ul v-if="list(s.requirements).length" class="mt-1 space-y-1">
        <li v-for="(r, ri) in list(s.requirements)" :key="`req-${si}-${ri}`" class="break-words">
          <span class="font-semibold" :class="r.critical ? 'text-red-700' : 'text-gray-800'">{{ categoryLabel(r.category) }}:</span>
          {{ r.text }}
          <span v-if="showFlags && r.flag" class="di-flag" :title="whyHidden(r)">Hidden from drivers</span>
        </li>
      </ul>
      <ul v-if="list(s.instructions).length" class="mt-1 space-y-1">
        <li v-for="(x, xi) in list(s.instructions)" :key="`ins-${si}-${xi}`" class="whitespace-pre-line break-words">
          <span class="font-semibold text-gray-800">{{ instructionKindLabel(x.kind) }}:</span>
          {{ x.text }}
          <span v-if="showFlags && x.flag" class="di-flag" :title="whyHidden(x)">Hidden from drivers</span>
        </li>
      </ul>
      <p v-if="!list(s.references).length && !list(s.requirements).length && !list(s.instructions).length" class="mt-1 text-xs text-gray-500">Nothing for this stop.</p>
    </div>
    <p v-if="!empty && payload && payload.footnote" class="text-xs italic text-gray-500">{{ payload.footnote }}</p>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { categoryLabel, instructionKindLabel, referenceLabel, stopKindLabel, whyHidden } from '../../lib/driverInstructionsView'

const props = defineProps({
  payload: { type: Object, default: null },
  showFlags: { type: Boolean, default: false },
})

const list = (v) => (Array.isArray(v) ? v : [])
const loadRequirements = computed(() => list(props.payload?.loadRequirements))
const stops = computed(() => list(props.payload?.stops))
const empty = computed(() => !loadRequirements.value.length && !stops.value.length)
</script>

<style scoped>
.di-flag {
  display: inline-block; margin-left: 0.25rem; padding: 0 6px; border-radius: 4px;
  font-size: 0.65rem; font-weight: 700; letter-spacing: 0.03em;
  background: #fef3c7; color: #92400e; border: 1px solid #fde68a; white-space: nowrap;
}
</style>
