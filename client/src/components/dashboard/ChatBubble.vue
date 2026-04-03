<template>
  <div :class="['msg-bubble', isSent ? 'sent' : 'received']">
    <div v-if="msg.loadId" class="msg-load-tag">{{ msg.loadId }}</div>
    <div v-if="msg.attachment_url" class="msg-attachment">
      <img v-if="msg.attachment_type === 'image'" :src="msg.attachment_url" class="msg-attach-img" />
      <a v-else :href="msg.attachment_url" target="_blank" class="msg-attach-file">{{ msg.attachment_type === 'pdf' ? 'PDF Document' : 'File Attachment' }}</a>
    </div>
    <div v-if="msg.message">{{ msg.message }}</div>
    <div class="msg-meta">
      {{ time }}
      <span v-if="isSent" class="read-tick" :class="{ read: msg.read }">{{ msg.read ? '&#10003;&#10003;' : '&#10003;' }}</span>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  msg: { type: Object, required: true },
})

const isSent = computed(() => {
  const from = (props.msg.from || '').toLowerCase()
  return from === 'dispatch' || from === 'admin' || from === 'super_admin'
})

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
.msg-attachment { margin-bottom: 0.3rem; }
.msg-attach-img { max-width: 200px; max-height: 150px; border-radius: 6px; display: block; }
.msg-attach-file {
  display: inline-block; padding: 0.3rem 0.6rem; background: rgba(255,255,255,0.2);
  border-radius: 5px; font-size: 0.78rem; color: inherit; text-decoration: underline;
}
</style>
