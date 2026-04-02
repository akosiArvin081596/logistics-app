<template>
  <div :class="['msg-bubble', isSent ? 'sent' : 'received']">
    <div v-if="msg.loadId" class="msg-load-tag">{{ msg.loadId }}</div>
    {{ msg.message }}
    <div class="msg-meta">
      {{ time }}
      <span v-if="isSent" class="read-tick" :class="{ read: msg.read }">{{ msg.read ? '✓✓' : '✓' }}</span>
    </div>
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

<style scoped>
.read-tick {
  margin-left: 4px;
  opacity: 0.5;
  font-size: 0.58rem;
}
.read-tick.read {
  opacity: 1;
  color: #93c5fd;
}
</style>
