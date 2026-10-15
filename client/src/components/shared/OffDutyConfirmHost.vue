<template>
  <!-- The one "Assign anyway?" dialog (R11): useOffDutyConfirm() opens it when
       an assign answers 409 DRIVER_OFF_DUTY. The safe choice, "Keep as is",
       is ConfirmModal's first button and takes the initial focus. -->
  <ConfirmModal
    :open="state.open"
    title="This driver is off"
    :message="state.message"
    confirm-text="Assign anyway"
    cancel-text="Keep as is"
    @confirm="answer(true)"
    @cancel="answer(false)"
  />
</template>

<script setup>
import ConfirmModal from './ConfirmModal.vue'
import { useOffDutyConfirm } from '../../composables/useOffDutyConfirm'

const { state, answer } = useOffDutyConfirm()
</script>
