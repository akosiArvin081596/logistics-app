<template>
  <div class="toast-container">
    <div :class="['toast', state.type, { show: state.visible }]">
      {{ state.message }}
    </div>
  </div>
</template>

<script setup>
import { useToast } from '../../composables/useToast'

const { state } = useToast()
</script>
