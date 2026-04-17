export function useApi() {
  async function request(url, options = {}) {
    const res = await fetch(url, {
      headers: { 'Content-Type': 'application/json', ...options.headers },
      ...options,
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`)
    return data
  }

  const get = (url) => request(url)
  const post = (url, body) => request(url, { method: 'POST', body: JSON.stringify(body) })
  const put = (url, body) => request(url, { method: 'PUT', body: JSON.stringify(body) })
  const patch = (url, body) => request(url, { method: 'PATCH', body: JSON.stringify(body) })
  const del = (url) => request(url, { method: 'DELETE' })

  return { get, post, put, patch, del }
}
