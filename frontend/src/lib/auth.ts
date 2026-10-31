import { create } from 'zustand'
import { api, refreshSession, setToken } from './api'

export type User = {
  id: string
  email: string
  display_name: string
  is_admin: boolean
}

type AuthState = {
  user: User | null
  ready: boolean
  bootstrap: () => Promise<void>
  login: (email: string, password: string) => Promise<void>
  register: (email: string, password: string, displayName: string) => Promise<void>
  logout: () => Promise<void>
}

export const useAuth = create<AuthState>((set) => ({
  user: null,
  ready: false,

  bootstrap: async () => {
    try {
      if (await refreshSession()) {
        const user = await api<User>('/auth/me')
        set({ user })
      }
    } catch {
      setToken(null)
    } finally {
      set({ ready: true })
    }
  },

  login: async (email, password) => {
    const data = await api<{ access_token: string; user: User }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    })
    setToken(data.access_token)
    set({ user: data.user })
  },

  register: async (email, password, displayName) => {
    const data = await api<{ access_token: string; user: User }>('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password, display_name: displayName }),
    })
    setToken(data.access_token)
    set({ user: data.user })
  },

  logout: async () => {
    try {
      await api('/auth/logout', { method: 'POST' })
    } catch {
      /* ignore */
    }
    setToken(null)
    set({ user: null })
  },
}))
