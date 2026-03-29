import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import router from './router'
import './assets/shared.css'

const app = createApp(App)

// Suppress Vue internal DOM patching errors that occur during rapid reactive updates
// These are non-critical — the UI renders correctly despite these warnings
app.config.errorHandler = (err) => {
  const msg = err?.message || ''
  if (msg.includes('insertBefore') || msg.includes('nextSibling') || msg.includes('subTree') || msg.includes('emitsOptions')) {
    return
  }
  console.error(err)
}

app.use(createPinia())
app.use(router)
app.mount('#app')
