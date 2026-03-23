<template>
  <Teleport to="#sidebarExtra">
    <div class="nav-group" :class="{ collapsed }">
      <button class="nav-group-toggle" @click="collapsed = !collapsed">
        Sheets <span class="chevron">&#9660;</span>
      </button>
      <div class="nav-children">
        <button
          v-for="tab in tabs"
          :key="tab"
          :class="['nav-item', { active: tab === currentSheet }]"
          @click="$emit('select', tab)"
        >
          <span class="nav-icon" v-html="getTabIcon(tab)"></span>
          {{ tab }}
        </button>
      </div>
    </div>
  </Teleport>
</template>

<script setup>
import { ref } from 'vue'

defineProps({
  tabs: { type: Array, required: true },
  currentSheet: { type: String, required: true },
})

defineEmits(['select'])

const collapsed = ref(false)

const tabIcons = {
  'Job Tracking': '&#9672;',
  'Job Details': '&#9776;',
  'Carrier Database': '&#9850;',
  'Status Logs': '&#9201;',
  'Payments Table': '&#36;',
  'Job Tracking Log': '&#9998;',
  'Carrier History': '&#8634;',
  'Job Summary Sheet': '&#9638;',
  'Messages': '&#128172;',
  'Expenses': '&#128176;',
}

function getTabIcon(name) {
  return tabIcons[name] || '&#9642;'
}
</script>
