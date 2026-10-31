/**
 * HTTP long-poll provider for Yjs.
 *
 * The network path to gw-22 does not forward WebSocket upgrades, so polling is
 * the primary transport.  This provider:
 *
 *  - syncs with `GET /collab/v1/doc/:id/sync?sv=<state vector>`
 *  - pushes local updates (debounced) with `POST .../update`
 *  - long-polls `GET .../poll?after=<seq>&timeout=25`
 *  - syncs awareness (presence) through `POST .../awareness`
 *  - reconnects with exponential backoff and re-syncs after every failure
 *
 * The Yjs document shape used by the editor is a single Y.Text named
 * `content` (see `useCollabDoc` / `y-codemirror.next`).
 */

import * as Y from 'yjs'
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from 'y-protocols/awareness'

import { BASE, getToken, refreshSession } from '../lib/api'
import { base64ToBytes, bytesToBase64 } from './base64'

export type CollabStatus = 'connecting' | 'connected' | 'offline' | 'error'

export type HttpYjsProviderOptions = {
  /** File id or document id accepted by the collab service. */
  docId: string
  doc: Y.Doc
  /** Reuse an Awareness instance if the caller also hands it to y-codemirror. */
  awareness?: Awareness
  /** Presence payload stored under awareness field `user`. */
  user?: Record<string, unknown>
  /** Long-poll timeout sent to the server (seconds). The server caps at 60. */
  pollTimeout?: number
  /** Override the API base, mainly for tests. */
  baseUrl?: string
  fetchImpl?: typeof fetch
  clientId?: string
}

type SyncResponse = {
  seq: number
  update: string
  awareness?: string[]
}

type PollResponse = {
  seq: number
  updates?: Array<{ seq: number; update: string }>
  awareness?: string[]
}

type StatusListener = (status: CollabStatus) => void
type SyncListener = () => void

/** Origin used for updates applied by the provider (never echoed back). */
export const PROVIDER_ORIGIN = Symbol('latex-studio-http-provider')

const DEFAULT_POLL_TIMEOUT = 25
const MAX_POLL_TIMEOUT = 60
const PUSH_DEBOUNCE_MS = 120
const AWARENESS_DEBOUNCE_MS = 60
const AWARENESS_HEARTBEAT_MS = 15_000
const CLIENT_REQUEST_TIMEOUT_MS = 45_000

export class CollabHttpError extends Error {
  status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'CollabHttpError'
    this.status = status
  }
}

function randomClientId(): string {
  const cryptoObj = typeof globalThis !== 'undefined' ? globalThis.crypto : undefined
  if (cryptoObj && typeof cryptoObj.randomUUID === 'function') {
    return cryptoObj.randomUUID()
  }
  return `client-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`
}

function collabBaseUrl(override?: string): string {
  if (override) return override
  const envUrl = import.meta.env.VITE_COLLAB_URL as string | undefined
  if (envUrl) return envUrl
  const base = BASE.endsWith('/') ? BASE : `${BASE}/`
  return `${base}collab/v1`
}

export class HttpYjsProvider {
  readonly doc: Y.Doc
  readonly awareness: Awareness
  readonly docId: string
  readonly clientId: string

  status: CollabStatus = 'offline'
  synced = false
  /** True once the server returned a non-empty document during sync. */
  hasServerState = false
  lastSeq = 0

  private readonly baseUrl: string
  private readonly fetchImpl: typeof fetch
  private readonly pollTimeout: number
  private readonly ownsAwareness: boolean
  private running = false

  private clientSeq = 0
  private pendingPush: { clientSeq: number; update: Uint8Array } | null = null
  private pendingBytes: Uint8Array[] = []
  private pushing = false
  private pushFailures = 0

  private pendingAwareness: Uint8Array[] = []
  private awarenessSending = false
  private awarenessFailures = 0

  private pushTimer: ReturnType<typeof setTimeout> | null = null
  private awarenessTimer: ReturnType<typeof setTimeout> | null = null
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null

  private readonly statusListeners = new Set<StatusListener>()
  private readonly syncListeners = new Set<SyncListener>()
  private readonly inflight = new Set<AbortController>()
  private readonly sleepers = new Set<() => void>()

  constructor(options: HttpYjsProviderOptions) {
    this.doc = options.doc
    this.docId = options.docId
    this.clientId = options.clientId ?? randomClientId()
    this.baseUrl = collabBaseUrl(options.baseUrl)
    // Bind: calling `this.fetchImpl(...)` otherwise loses the Window receiver
    // and browsers throw "Illegal invocation".
    this.fetchImpl = options.fetchImpl ?? fetch.bind(globalThis)
    this.pollTimeout = Math.min(Math.max(options.pollTimeout ?? DEFAULT_POLL_TIMEOUT, 1), MAX_POLL_TIMEOUT)
    this.ownsAwareness = !options.awareness
    this.awareness = options.awareness ?? new Awareness(this.doc)

    if (options.user) {
      this.awareness.setLocalStateField('user', options.user)
    }

    this.doc.on('update', this.onDocUpdate)
    this.awareness.on('update', this.onAwarenessUpdate)
  }

  // --------------------------------------------------------------- public API
  connect(): void {
    if (this.running) return
    this.running = true
    this.setStatus('connecting')
    void this.run()
  }

  destroy(): void {
    if (!this.running && this.status === 'offline') {
      // Still clean up listeners/timers on repeated calls.
    }
    this.running = false
    this.synced = false

    if (this.pushTimer) clearTimeout(this.pushTimer)
    if (this.awarenessTimer) clearTimeout(this.awarenessTimer)
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.pushTimer = null
    this.awarenessTimer = null
    this.heartbeatTimer = null

    for (const controller of this.inflight) controller.abort()
    this.inflight.clear()
    for (const wake of [...this.sleepers]) wake()
    this.sleepers.clear()

    this.doc.off('update', this.onDocUpdate)
    this.awareness.off('update', this.onAwarenessUpdate)

    if (this.ownsAwareness) {
      removeAwarenessStates(this.awareness, [this.doc.clientID], 'destroy')
      const awareness = this.awareness as Awareness & { destroy?: () => void }
      if (typeof awareness.destroy === 'function') awareness.destroy()
    }

    this.setStatus('offline')
    this.statusListeners.clear()
    this.syncListeners.clear()
  }

  onStatus(listener: StatusListener): () => void {
    this.statusListeners.add(listener)
    listener(this.status)
    return () => this.statusListeners.delete(listener)
  }

  onSync(listener: SyncListener): () => void {
    this.syncListeners.add(listener)
    return () => this.syncListeners.delete(listener)
  }

  setLocalUser(user: Record<string, unknown>): void {
    this.awareness.setLocalStateField('user', user)
  }

  /**
   * Push everything queued and force the server to persist to Postgres.
   * Call this before requesting a compile so `documents.content` is current.
   */
  async flush(): Promise<void> {
    // Wait for an in-flight push, then drain the queue with a fixed client_seq.
    for (let i = 0; i < 200 && this.pushing; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    const ok = await this.flushPush()
    if (!ok) throw new Error('could not push pending updates before flush')
    await this.request(this.docPath('flush'), { method: 'POST' })
  }

  // ------------------------------------------------------------- connectivity
  private async run(): Promise<void> {
    let failures = 0
    while (this.running) {
      try {
        this.setStatus('connecting')
        await this.performSync()
        failures = 0
        this.pushFailures = 0
        this.schedulePush(0)
        this.scheduleAwarenessSend(0)
        this.startHeartbeat()
        this.setStatus('connected')
        await this.pollLoop()
      } catch (error) {
        if (!this.running) break
        this.setStatus('offline')
        failures += 1
        if (failures === 1) this.emitError(error)
        await this.sleep(Math.min(30_000, 500 * 2 ** Math.min(failures, 6)))
      }
    }
    this.setStatus('offline')
  }

  private async performSync(): Promise<void> {
    const stateVector = bytesToBase64(Y.encodeStateVector(this.doc))
    const query = new URLSearchParams({
      sv: stateVector,
      client_id: this.clientId,
    })
    const response = await this.request(`${this.docPath('sync')}?${query.toString()}`, {
      method: 'GET',
    })
    const data = (await response.json()) as SyncResponse

    if (typeof data.seq === 'number') {
      this.lastSeq = Math.max(this.lastSeq, data.seq)
    }
    if (data.update) {
      const update = base64ToBytes(data.update)
      if (update.length > 2) this.hasServerState = true
      Y.applyUpdate(this.doc, update, PROVIDER_ORIGIN)
    }
    this.applyAwareness(data.awareness)

    this.synced = true
    for (const listener of [...this.syncListeners]) listener()
  }

  private async pollLoop(): Promise<void> {
    while (this.running) {
      const query = new URLSearchParams({
        after: String(this.lastSeq),
        timeout: String(this.pollTimeout),
        client_id: this.clientId,
      })
      const response = await this.request(
        `${this.docPath('poll')}?${query.toString()}`,
        { method: 'GET' },
        this.pollTimeout * 1000 + 20_000,
      )

      if (response.status === 204) {
        // No updates within the hold window; immediately start the next poll.
        await this.sleep(200)
        continue
      }

      const data = (await response.json()) as PollResponse
      if (typeof data.seq === 'number') {
        this.lastSeq = Math.max(this.lastSeq, data.seq)
      }
      for (const item of data.updates ?? []) {
        if (!item?.update) continue
        try {
          Y.applyUpdate(this.doc, base64ToBytes(item.update), PROVIDER_ORIGIN)
        } catch {
          // A corrupt update is ignored; the next poll/sync will reconcile.
        }
      }
      this.applyAwareness(data.awareness)
      this.setStatus('connected')
    }
  }

  // ------------------------------------------------------------ local updates
  private onDocUpdate = (update: Uint8Array, origin: unknown): void => {
    if (origin === PROVIDER_ORIGIN) return
    this.pendingBytes.push(update)
    this.schedulePush(PUSH_DEBOUNCE_MS)
  }

  private schedulePush(delay: number): void {
    if (!this.running || this.pushTimer !== null) return
    this.pushTimer = setTimeout(() => {
      this.pushTimer = null
      void this.flushPush()
    }, delay)
  }

  /** Returns false only when a push failed and will be retried. */
  private async flushPush(): Promise<boolean> {
    if (this.pushing) return true
    this.pushing = true
    try {
      while (this.running && (this.pendingPush || this.pendingBytes.length > 0)) {
        if (!this.pendingPush) {
          const batch = this.pendingBytes.splice(0)
          const update = batch.length === 1 ? batch[0] : Y.mergeUpdates(batch)
          this.pendingPush = { clientSeq: ++this.clientSeq, update }
        }

        const pending = this.pendingPush
        const body = JSON.stringify({
          client_id: this.clientId,
          client_seq: pending.clientSeq,
          update: bytesToBase64(pending.update),
        })
        // A retry reuses the same client_seq, so the server's Redis dedupe
        // returns the original seq instead of applying it twice.
        await this.request(this.docPath('update'), { method: 'POST', body })
        this.pendingPush = null
        this.pushFailures = 0
      }
      return true
    } catch (error) {
      if (this.isPermanentFailure(error)) {
        // 400/403/413 will never succeed on retry (e.g. oversize document or
        // read-only viewer). Drop the batch instead of blocking the queue.
        this.pendingPush = null
        this.pendingBytes = []
        this.setStatus('error')
        this.emitError(error)
        return false
      }
      this.pushFailures += 1
      if (this.running) {
        this.setStatus('offline')
        this.emitError(error)
        this.schedulePush(Math.min(30_000, 500 * 2 ** Math.min(this.pushFailures, 6)))
      }
      return false
    } finally {
      this.pushing = false
    }
  }

  // ---------------------------------------------------------------- awareness
  private onAwarenessUpdate = (
    changes: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ): void => {
    if (!this.running || origin === PROVIDER_ORIGIN) return
    const changed = [...changes.added, ...changes.updated, ...changes.removed]
    if (changed.length === 0) return
    this.pendingAwareness.push(encodeAwarenessUpdate(this.awareness, changed))
    this.scheduleAwarenessSend(AWARENESS_DEBOUNCE_MS)
  }

  private scheduleAwarenessSend(delay: number): void {
    if (!this.running || this.awarenessTimer !== null) return
    this.awarenessTimer = setTimeout(() => {
      this.awarenessTimer = null
      void this.flushAwareness()
    }, delay)
  }

  private async flushAwareness(): Promise<void> {
    if (this.awarenessSending) return
    this.awarenessSending = true
    try {
      while (this.running && this.pendingAwareness.length > 0) {
        const update = this.pendingAwareness[0]
        const body = JSON.stringify({
          client_id: this.clientId,
          update: bytesToBase64(update),
        })
        try {
          await this.request(this.docPath('awareness'), { method: 'POST', body })
          this.pendingAwareness.shift()
          this.awarenessFailures = 0
        } catch (error) {
          if (this.isPermanentFailure(error)) {
            this.pendingAwareness.shift()
            this.awarenessFailures = 0
            this.emitError(error)
            continue
          }
          this.awarenessFailures += 1
          this.emitError(error)
          if (this.running) {
            this.scheduleAwarenessSend(
              Math.min(30_000, 500 * 2 ** Math.min(this.awarenessFailures, 6)),
            )
          }
          return
        }
      }
    } finally {
      this.awarenessSending = false
    }
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer !== null) return
    this.heartbeatTimer = setInterval(() => {
      if (!this.running || !this.synced) return
      const local = this.awareness.getLocalState()
      if (!local) return
      // Re-publish only our own state so the server-side 30 s TTL stays hot;
      // remote clients' states belong to their own awareness entries.
      this.pendingAwareness.push(
        encodeAwarenessUpdate(this.awareness, [this.doc.clientID]),
      )
      void this.flushAwareness()
    }, AWARENESS_HEARTBEAT_MS)
  }

  private applyAwareness(updates?: string[]): void {
    for (const encoded of updates ?? []) {
      try {
        applyAwarenessUpdate(this.awareness, base64ToBytes(encoded), PROVIDER_ORIGIN)
      } catch {
        // Ignore malformed/stale awareness updates.
      }
    }
  }

  // ------------------------------------------------------------------- fetch
  private docPath(suffix: string): string {
    return `doc/${encodeURIComponent(this.docId)}/${suffix}`
  }

  private async request(
    path: string,
    init: RequestInit = {},
    timeoutMs = CLIENT_REQUEST_TIMEOUT_MS,
  ): Promise<Response> {
    const controller = new AbortController()
    this.inflight.add(controller)
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    const doFetch = async (): Promise<Response> => {
      const headers = new Headers(init.headers)
      if (init.body && !headers.has('Content-Type')) {
        headers.set('Content-Type', 'application/json')
      }
      const token = getToken()
      if (token) headers.set('Authorization', `Bearer ${token}`)
      return this.fetchImpl(joinUrl(this.baseUrl, path), {
        ...init,
        headers,
        credentials: 'include',
        signal: controller.signal,
      })
    }

    try {
      let response = await doFetch()
      if (response.status === 401) {
        if (await refreshSession()) {
          response = await doFetch()
        }
      }
      if (!response.ok) {
        const detail = await response.text().catch(() => '')
        throw new CollabHttpError(response.status, detail || `${response.status} ${response.statusText}`)
      }
      return response
    } finally {
      clearTimeout(timer)
      this.inflight.delete(controller)
    }
  }

  // -------------------------------------------------------------------- misc
  private sleep(ms: number): Promise<void> {
    if (!this.running) return Promise.resolve()
    return new Promise<void>((resolve) => {
      const wake = () => {
        clearTimeout(timer)
        this.sleepers.delete(wake)
        resolve()
      }
      const timer = setTimeout(wake, ms)
      this.sleepers.add(wake)
    })
  }

  private isPermanentFailure(error: unknown): boolean {
    if (!(error instanceof CollabHttpError)) return false
    if (error.status < 400 || error.status >= 500) return false
    // 401 is handled by refreshSession; 408/425/429 are transient.
    return ![401, 408, 425, 429].includes(error.status)
  }

  private setStatus(status: CollabStatus): void {
    if (this.status === status) return
    this.status = status
    for (const listener of [...this.statusListeners]) listener(status)
  }

  private emitError(error: unknown): void {
    // Status listeners get the failure; keep console noise low in production.
    if (import.meta.env.DEV) {
      // eslint-disable-next-line no-console
      console.warn('[collab] transport error', error)
    }
  }
}
