import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { Locale } from 'vant'
import enUS from 'vant/es/locale/lang/en-US'
import App from './App.vue'
import router from './router'
import './assets/shared.css'

Locale.use('en-US', enUS)

const app = createApp(App)

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
