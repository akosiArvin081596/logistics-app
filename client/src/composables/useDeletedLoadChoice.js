// One form's "deleted before" question (DeletedLoadChoiceModal.vue): ask() opens it with the server's choice and
// resolves with what the Super Admin picked; answer() closes it. One per form, unlike the app-wide off-duty dialog.
import { reactive } from 'vue'

export function useDeletedLoadChoice() {
  const state = reactive({ open: false, choice: null, note: '' })
  let pending = null

  function answer(value) {
    const resolve = pending
    pending = null
    state.open = false
    if (resolve) resolve(value || null)
  }

  // A second question answers the first "no".
  function ask(choice, note = '') {
    if (pending) answer(null)
    state.choice = choice
    state.note = note || ''
    state.open = true
    return new Promise((resolve) => { pending = resolve })
  }

  return { state, ask, answer }
}
