<template>
  <div :class="['msg-bubble', isSent ? 'sent' : 'received']">
    <div v-if="msg.loadId" class="msg-load-tag">{{ msg.loadId }}</div>
    <!-- A voice note the server measured plays from its own route; any other
         row (one this reader may not play, a removed file) shows its text. -->
    <div v-if="voice" class="msg-attachment">
      <VoiceNotePlayer :src="voiceNoteSrc(msg)" :duration-ms="Number(msg.voice_duration_ms)" :sent="isSent" />
    </div>
    <div v-else-if="msg.attachment_url" class="msg-attachment">
      <!-- A photo opens full size (MessagingPanel's viewer); focus comes back
           to this button when the viewer closes. -->
      <button
        v-if="photo"
        type="button"
        class="msg-attach-photo"
        :aria-label="`Open full size: ${photoAlt}`"
        @click="emit('open-photo', msg)"
      >
        <img :src="msg.attachment_url" :alt="photoAlt" class="msg-attach-img" />
      </button>
      <a v-else-if="ownFile" :href="msg.attachment_url" target="_blank" class="msg-attach-file">{{ msg.attachment_type === 'pdf' ? 'PDF Document' : 'File Attachment' }}</a>
      <span v-else class="msg-attach-file">File unavailable</span>
    </div>
    <div v-if="msg.message && !voice">{{ msg.message }}</div>
    <div class="msg-meta">
      {{ time }}
      <span v-if="isSent" class="read-tick" :class="{ read: msg.read }">{{ msg.read ? '&#10003;&#10003;' : '&#10003;' }}</span>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { fmtAppInstant } from '../../utils/datetime'
import { chatPhotoAlt, isChatPhoto, isOwnUploadUrl } from '../../lib/chatPhotos'
import { isServerVoiceNote, voiceNoteSrc } from '../../lib/voiceNotes'
import VoiceNotePlayer from '../shared/VoiceNotePlayer.vue'

const props = defineProps({
  msg: { type: Object, required: true },
})
const emit = defineEmits(['open-photo'])

const voice = computed(() => isServerVoiceNote(props.msg))
const photo = computed(() => isChatPhoto(props.msg))
const ownFile = computed(() => isOwnUploadUrl(props.msg.attachment_url))
const photoAlt = computed(() => chatPhotoAlt(props.msg))

const isSent = computed(() => {
  const from = (props.msg.from || '').toLowerCase()
  return from === 'dispatch' || from === 'admin' || from === 'super_admin'
})

// Message times render in the app zone (APP_TIMEZONE, US Eastern) with a
// visible zone label, never the viewer's zone. `msg.timestamp` is a true instant
// (ISO-Z from the server), so without the pin the same bubble reads 8:05 AM in
// the US and 9:05 PM in Manila on one shared super_admin login.
const time = computed(() => fmtAppInstant(props.msg.timestamp, { hour: 'numeric', minute: '2-digit', fallback: '' }))
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
.msg-attach-photo {
  display: block; padding: 0; border: none; background: none; border-radius: 6px;
  cursor: zoom-in; font: inherit; color: inherit;
}
.msg-attach-photo:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; }
.msg-attach-img { max-width: 200px; max-height: 150px; border-radius: 6px; display: block; }
.msg-attach-file {
  display: inline-block; padding: 0.3rem 0.6rem; background: rgba(255,255,255,0.2);
  border-radius: 5px; font-size: 0.78rem; color: inherit; text-decoration: underline;
}
</style>
