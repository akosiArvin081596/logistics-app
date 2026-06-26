import { ref } from 'vue'
import { useApi } from './useApi'

// Resilient document-upload composable. Mirrors the server's canonical
// retry/timeout shape (lib/routemate-client.js): generous per-attempt timeout,
// up to 3 attempts with exponential backoff, fail-fast on non-429 4xx. Used by
// DocumentUpload.vue (driver POD/BOL + admin dashboard) to survive flaky
// cellular uploads that previously died silently behind nginx (499).
export function useUpload() {
  const api = useApi()
  const uploading = ref(false)
  const progress = ref({ done: 0, total: 0, label: '' })

  // tasks: Array<{ label: string, body: object }>  (body POSTed to /api/documents/upload)
  // returns { ok: number, failed: Array<{ index, label, error }> }  (index = task position)
  async function uploadDocuments(tasks) {
    uploading.value = true
    progress.value = { done: 0, total: tasks.length, label: '' }
    const failed = []; let ok = 0
    for (let i = 0; i < tasks.length; i++) {
      const t = tasks[i]
      progress.value = { ...progress.value, label: t.label }
      try { await postWithRetry('/api/documents/upload', t.body); ok++ }
      catch (e) { failed.push({ index: i, label: t.label, error: e }) }
      progress.value = { ...progress.value, done: progress.value.done + 1 }
    }
    uploading.value = false
    return { ok, failed }
  }

  async function postWithRetry(url, body) {
    let lastErr
    for (let attempt = 0; attempt <= 2; attempt++) {       // 3 attempts
      try { return await api.post(url, body, { timeout: 90000 }) }   // generous; >= nginx body timeout
      catch (e) {
        lastErr = e
        if (e.code === 'ABORT') throw e                      // caller cancelled — never retry
        const s = e.status || 0
        if (s >= 400 && s < 500 && s !== 429) throw e        // fail-fast non-429 4xx (403/413)
        if (attempt < 2) await new Promise(r => setTimeout(r, 500 * Math.pow(2, attempt)))  // exp backoff
      }
    }
    throw lastErr
  }

  return { uploadDocuments, uploading, progress }
}
