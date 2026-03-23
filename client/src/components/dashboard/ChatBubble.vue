<template>
  <div :class="['msg-bubble', isSent ? 'sent' : 'received']">
    <div v-if="msg.loadId" class="msg-load-tag">{{ msg.loadId }}</div>
    {{ msg.message }}
    <div class="msg-meta">{{ time }}</div>
  </div>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  msg: { type: Object, required: true },
})

const isSent = computed(() => (props.msg.from || '').toLowerCase() === 'dispatch')

const time = computed(() => {
  const t = new Date(props.msg.timestamp)
  return isNaN(t) ? '' : t.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
})
</script>
