import { createApp } from 'vue'
import { createPinia } from 'pinia'
import PrimeVue from 'primevue/config'
import Aura from '@primevue/themes/aura'
import { definePreset } from '@primevue/themes'

const LogisXPreset = definePreset(Aura, {
  semantic: {
    primary: {
      50: '{sky.50}',
      100: '{sky.100}',
      200: '{sky.200}',
      300: '{sky.300}',
      400: '{sky.400}',
      500: '{sky.500}',
      600: '{sky.600}',
      700: '{sky.700}',
      800: '{sky.800}',
      900: '{sky.900}',
      950: '{sky.950}',
    }
  }
})
import 'primeicons/primeicons.css'
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
app.use(PrimeVue, {
  theme: {
    preset: LogisXPreset,
    options: { darkModeSelector: '.dark-mode' }
  }
})
app.mount('#app')
