export function useApi() {
  async function request(url, options = {}) {
    const res = await fetch(url, {
      headers: { 'Content-Type': 'application/json', ...options.headers },
      ...options,
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
  }

  const get = (url) => request(url)
  const post = (url, body) => request(url, { method: 'POST', body: JSON.stringify(body) })
  const put = (url, body) => request(url, { method: 'PUT', body: JSON.stringify(body) })
  const patch = (url, body) => request(url, { method: 'PATCH', body: JSON.stringify(body) })
  const del = (url) => request(url, { method: 'DELETE' })

  return { get, post, put, patch, del }
}
