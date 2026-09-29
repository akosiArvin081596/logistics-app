<template>
  <InviteModal :open="open" :title="title" :close-on-backdrop="false" @close="$emit('close')">
    <label class="form-label" :for="inputId">Personal invite link</label>
    <div class="link-row">
      <input
        :id="inputId"
        ref="inputRef"
        class="form-input link-input"
        data-test="invite-link"
        type="text"
        readonly
        autofocus
        :value="link"
        :aria-describedby="noteId"
        @focus="selectAll"
      />
      <button type="button" class="btn btn-primary" data-test="invite-link-copy" @click="copy">Copy</button>
    </div>
    <p class="copy-status" role="status" aria-live="polite">{{ copyStatus }}</p>
    <p :id="noteId" class="link-note">This link is shown once. Creating a new link stops this one immediately, including for anyone part-way through the application.</p>
    <div class="link-actions">
      <button type="button" class="btn btn-secondary" @click="$emit('close')">Done</button>
    </div>
  </InviteModal>
</template>

<script setup>
import { computed, ref, useId, watch } from 'vue'
import InviteModal from './InviteModal.vue'

const props = defineProps({
  open: { type: Boolean, default: false },
  // "/invest?invite=<token>" as the server returned it, once.
  invitePath: { type: String, default: '' },
  inviteeName: { type: String, default: '' },
  reissued: { type: Boolean, default: false },
})

defineEmits(['close'])

const uid = useId()
const inputId = `invite-link-${uid}`
const noteId = `invite-link-note-${uid}`
const inputRef = ref(null)
const copyStatus = ref('')

const link = computed(() => (props.invitePath ? `${window.location.origin}${props.invitePath}` : ''))
const title = computed(() => {
  const who = props.inviteeName ? ` for ${props.inviteeName}` : ''
  return props.reissued ? `New invite link${who}` : `Invite created${who}`
})

watch(() => props.open, () => { copyStatus.value = '' })

function selectAll(event) {
  event.target.select()
}

async function copy() {
  try {
    await navigator.clipboard.writeText(link.value)
    copyStatus.value = 'Link copied.'
  } catch {
    inputRef.value?.focus()
    inputRef.value?.select()
    copyStatus.value = "Couldn't copy automatically. The link is selected: press Ctrl+C (or Cmd+C) to copy it."
  }
}
</script>

<style scoped>
.link-row {
  display: flex;
  gap: 0.5rem;
  align-items: stretch;
}
.link-input {
  flex: 1;
  min-width: 0;
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.78rem;
}
.copy-status {
  min-height: 1.2em;
  margin: 0.35rem 0 0;
  font-size: 0.75rem;
  color: var(--text-dim);
}
.link-note {
  margin: 0.5rem 0 0;
  padding: 0.6rem 0.75rem;
  border-radius: 8px;
  background: var(--amber-dim);
  color: #92400e;
  font-size: 0.8rem;
  line-height: 1.45;
}
.link-actions {
  display: flex;
  justify-content: flex-end;
  margin-top: 1.25rem;
}
</style>
