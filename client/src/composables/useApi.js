export function useApi() {
  // request(url, { timeout, signal, ...fetchOptions })
  // Wraps fetch with an AbortController-backed timeout (default 20s) so hung
  // requests (e.g. POD uploads stalling on flaky cellular behind nginx) fail
  // with a clear, retryable error instead of dying silently. A caller-supplied
  // `signal` is composed with the internal controller so either source can cancel.
  async function request(url, options = {}) {
    const { timeout = 20000, signal, ...fetchOptions } = options
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeout)

    // Compose an external signal: when the caller aborts, abort our controller too.
    let onExternalAbort
    if (signal) {
      if (signal.aborted) controller.abort()
      else {
        onExternalAbort = () => controller.abort()
        signal.addEventListener('abort', onExternalAbort)
      }
    }

    try {
      const res = await fetch(url, {
        headers: { 'Content-Type': 'application/json', ...fetchOptions.headers },
        ...fetchOptions,
        signal: controller.signal,
      })
      // Non-JSON responses (nginx 413, gateway errors, etc.) used to crash
      // res.json() and bubble up an opaque SyntaxError. Fall back to a friendly
      // message so the caller can surface something meaningful.
      let data = {}
      try { data = await res.json() } catch { data = {} }
      if (!res.ok) {
        const fallback = res.status === 413
          ? 'File too large for the server to accept.'
          : `Request failed (${res.status})`
        const err = new Error(data.error || fallback)
        err.status = res.status
        err.code = data.code || ''
        err.data = data
        throw err
      }
      return data
    } catch (err) {
      // A timeout (or composed caller-abort) surfaces as an AbortError — convert
      // it into a clear, retryable error the upload retry loop can branch on.
      if (err.name === 'AbortError') {
        // Distinguish a caller-initiated cancel from our own timeout firing:
        // only the external signal sets signal.aborted (the timer aborts the
        // internal controller instead). A cancel must not be retried as a timeout.
        const cancelled = !!(signal && signal.aborted)
        const e = new Error(cancelled
          ? 'Request cancelled.'
          : 'The request timed out. Please check your connection and try again.')
        e.code = cancelled ? 'ABORT' : 'TIMEOUT'
        e.status = 0
        throw e
      }
      throw err
    } finally {
      clearTimeout(timer)
      if (onExternalAbort) signal.removeEventListener('abort', onExternalAbort)
    }
  }

  const get = (url, opts) => request(url, opts)
  const post = (url, body, opts = {}) => request(url, { method: 'POST', body: JSON.stringify(body), ...opts })
  const put = (url, body, opts = {}) => request(url, { method: 'PUT', body: JSON.stringify(body), ...opts })
  const patch = (url, body, opts = {}) => request(url, { method: 'PATCH', body: JSON.stringify(body), ...opts })
  const del = (url, opts) => request(url, { method: 'DELETE', ...(opts || {}) })

  return { get, post, put, patch, del }
}
