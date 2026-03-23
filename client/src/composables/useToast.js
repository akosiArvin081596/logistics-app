import { reactive } from 'vue'

const state = reactive({ message: '', type: 'success', visible: false })
let timeout = null

export function useToast() {
  function show(message, type = 'success') {
    state.message = message
    state.type = type
    state.visible = true
    clearTimeout(timeout)
    timeout = setTimeout(() => (state.visible = false), 3000)
  }

  return { state, show }
}
