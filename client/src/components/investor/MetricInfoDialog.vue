<template>
  <Dialog :open="open" @update:open="onUpdateOpen">
    <DialogContent class="metric-info-modal">
      <DialogHeader>
        <DialogTitle>{{ title }}</DialogTitle>
        <DialogDescription>{{ subtitle }}</DialogDescription>
      </DialogHeader>
      <slot />
    </DialogContent>
  </Dialog>
</template>

<script setup>
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '../ui/dialog'

defineProps({
  open: { type: Boolean, default: false },
  title: { type: String, default: '' },
  subtitle: { type: String, default: '' },
})

const emit = defineEmits(['update:open'])

function onUpdateOpen(v) {
  emit('update:open', v)
}
</script>
