const BASE = import.meta.env.BASE_URL // "/studio/"

let accessToken: string | null = null

export function getToken(): string | null {
  return accessToken
}

export function setToken(token: string | null) {
  accessToken = token
}

export async function refreshSession(): Promise<boolean> {
  const res = await fetch(`${BASE}api/v1/auth/refresh`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  })
  if (!res.ok) return false
  const data = await res.json()
  accessToken = data.access_token
  return true
}

async function doFetch(path: string, opts: RequestInit): Promise<Response> {
  const headers = new Headers(opts.headers)
  if (opts.body && !(opts.body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }
  if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`)
  return fetch(`${BASE}api/v1${path}`, {
    ...opts,
    headers,
    credentials: 'include',
  })
}

export async function api<T = unknown>(path: string, opts: RequestInit = {}): Promise<T> {
  let res = await doFetch(path, opts)
  if (res.status === 401) {
    if (await refreshSession()) {
      res = await doFetch(path, opts)
    }
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(detail || `${res.status} ${res.statusText}`)
  }
  if (res.status === 204) return undefined as T
  const type = res.headers.get('content-type') || ''
  return (type.includes('application/json') ? res.json() : res.text()) as Promise<T>
}

export { BASE }
