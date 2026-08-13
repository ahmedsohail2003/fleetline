/**
 * Hand-rolled typed client for the rosbridge v2 websocket JSON protocol
 * (https://github.com/RobotWebTools/rosbridge_suite — the wire protocol
 * spoken by `rosbridge_server` and by roslibjs/Foxglove-style tooling).
 *
 * Implements the subset Fleetline needs, properly:
 *   - subscribe / unsubscribe with per-subscription ids and fan-out to
 *     multiple local callbacks over a single wire subscription per topic
 *   - advertise / unadvertise / publish (publish requires a prior advertise,
 *     as the protocol does)
 *   - call_service with id-matched service_response and a timeout
 *   - automatic reconnect with exponential backoff; the full subscribe +
 *     advertise registry is replayed on every (re)connect
 *
 * No dependencies: the browser's native WebSocket by default (Node >= 21's
 * global WebSocket works in tests), injectable for anything else. All wire
 * messages are JSON — one of the reasons Fleetline talks rosbridge instead
 * of DDS directly: it is the web-native door into a ROS 2 graph.
 */

// ---------------------------------------------------------------------------
// Wire protocol types (the subset used here)
// ---------------------------------------------------------------------------

interface SubscribeOp {
  op: 'subscribe'
  id: string
  topic: string
  type: string
  throttle_rate?: number
  queue_length?: number
}

interface UnsubscribeOp {
  op: 'unsubscribe'
  id: string
  topic: string
}

interface AdvertiseOp {
  op: 'advertise'
  id: string
  topic: string
  type: string
}

interface UnadvertiseOp {
  op: 'unadvertise'
  id: string
  topic: string
}

interface PublishOp {
  op: 'publish'
  id?: string
  topic: string
  msg: unknown
}

interface CallServiceOp {
  op: 'call_service'
  id: string
  service: string
  type?: string
  args?: Record<string, unknown>
}

type OutgoingOp = SubscribeOp | UnsubscribeOp | AdvertiseOp | UnadvertiseOp | PublishOp | CallServiceOp

interface IncomingPublish {
  op: 'publish'
  topic: string
  msg: unknown
}

interface IncomingServiceResponse {
  op: 'service_response'
  id?: string
  service: string
  values?: unknown
  result: boolean
}

interface IncomingStatus {
  op: 'status'
  level: 'error' | 'warning' | 'info' | 'none'
  msg: string
  id?: string
}

type IncomingOp = IncomingPublish | IncomingServiceResponse | IncomingStatus

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/**
 * Connection lifecycle:
 *   idle -> connecting -> connected
 *   connected/connecting -> error (lost or refused; retry timer armed)
 *   error -> connecting (backoff elapsed, or retryNow())
 *   any -> closed (close() — no further retries)
 */
export type RosbridgeStatus = 'idle' | 'connecting' | 'connected' | 'error' | 'closed'

/** Minimal structural WebSocket surface (browser WebSocket, Node's global
 * WebSocket, and the `ws` package all satisfy it). */
export interface WebSocketLike {
  readyState: number
  send(data: string): void
  close(): void
  onopen: ((ev?: unknown) => void) | null
  onclose: ((ev?: unknown) => void) | null
  onerror: ((ev?: unknown) => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
}

export type WebSocketCtor = new (url: string) => WebSocketLike

const WS_OPEN = 1

export interface RosbridgeClientOptions {
  /** WebSocket constructor override; defaults to globalThis.WebSocket. */
  webSocketImpl?: WebSocketCtor
  /** First reconnect delay; doubles per consecutive failure. Default 500 ms. */
  initialBackoffMs?: number
  /** Backoff ceiling. Default 8000 ms. */
  maxBackoffMs?: number
  /** call_service timeout. Default 5000 ms. */
  serviceTimeoutMs?: number
  /** Connection status changes (chip + event-log hook). */
  onStatus?: (status: RosbridgeStatus, detail: string) => void
  /** op:'status' diagnostics pushed by the server. */
  onServerStatus?: (level: IncomingStatus['level'], msg: string) => void
}

interface SubscriptionEntry {
  type: string
  id: string
  throttleRate?: number
  callbacks: Set<(msg: unknown) => void>
}

interface PendingServiceCall {
  resolve: (values: unknown) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export class RosbridgeClient {
  readonly url: string
  status: RosbridgeStatus = 'idle'
  /** Consecutive failed connection attempts since the last successful open. */
  attempts = 0
  /** Delay before the next automatic retry (informational, for the UI). */
  nextRetryMs = 0

  private readonly wsCtor: WebSocketCtor
  private readonly initialBackoffMs: number
  private readonly maxBackoffMs: number
  private readonly serviceTimeoutMs: number
  private readonly onStatus?: (status: RosbridgeStatus, detail: string) => void
  private readonly onServerStatus?: (level: IncomingStatus['level'], msg: string) => void

  private ws: WebSocketLike | null = null
  private subs = new Map<string, SubscriptionEntry>()
  private adverts = new Map<string, { type: string; id: string }>()
  private pendingCalls = new Map<string, PendingServiceCall>()
  private seq = 0
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private closedByUser = false

  constructor(url: string, opts: RosbridgeClientOptions = {}) {
    this.url = url
    const fallbackCtor = (globalThis as { WebSocket?: unknown }).WebSocket as WebSocketCtor | undefined
    const ctor = opts.webSocketImpl ?? fallbackCtor
    if (!ctor) throw new Error('No WebSocket implementation available — pass webSocketImpl')
    this.wsCtor = ctor
    this.initialBackoffMs = opts.initialBackoffMs ?? 500
    this.maxBackoffMs = opts.maxBackoffMs ?? 8000
    this.serviceTimeoutMs = opts.serviceTimeoutMs ?? 5000
    this.onStatus = opts.onStatus
    this.onServerStatus = opts.onServerStatus
  }

  // --- Connection --------------------------------------------------------

  connect(): void {
    if (this.ws) return // already connecting or connected
    this.closedByUser = false
    this.clearRetry()
    this.setStatus('connecting', `connecting to ${this.url}`)

    let ws: WebSocketLike
    try {
      ws = new this.wsCtor(this.url)
    } catch (e) {
      this.attempts++
      this.setStatus('error', e instanceof Error ? e.message : 'failed to open websocket')
      this.scheduleRetry()
      return
    }
    this.ws = ws

    ws.onopen = () => {
      if (this.ws !== ws) return
      this.attempts = 0
      this.nextRetryMs = 0
      this.setStatus('connected', `connected to ${this.url}`)
      this.replayRegistry()
    }
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return
      this.handleMessage(typeof ev.data === 'string' ? ev.data : String(ev.data))
    }
    ws.onerror = () => {
      // Detail-free by spec; the close handler owns state transitions.
    }
    ws.onclose = () => {
      if (this.ws !== ws) return
      this.ws = null
      this.rejectAllPending(new Error('rosbridge connection closed'))
      if (this.closedByUser) {
        this.setStatus('closed', 'closed')
        return
      }
      this.attempts++
      this.scheduleRetry()
      this.setStatus(
        'error',
        `connection to ${this.url} failed or was lost (attempt ${this.attempts}, retrying in ${(this.nextRetryMs / 1000).toFixed(1)} s)`,
      )
    }
  }

  /** Stop for good: no reconnects, all pending service calls rejected. */
  close(): void {
    this.closedByUser = true
    this.clearRetry()
    if (this.ws) {
      const ws = this.ws
      this.ws = null
      ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null
      try {
        ws.close()
      } catch {
        // already dead — nothing to do
      }
    }
    this.rejectAllPending(new Error('rosbridge client closed'))
    this.setStatus('closed', 'closed')
  }

  /** Skip the current backoff wait and try immediately. */
  retryNow(): void {
    if (this.status === 'connected' || this.status === 'connecting') return
    this.clearRetry()
    this.connect()
  }

  isConnected(): boolean {
    return this.status === 'connected' && this.ws !== null && this.ws.readyState === WS_OPEN
  }

  // --- Topics --------------------------------------------------------------

  /**
   * Subscribe to a topic. Multiple local callbacks share one wire
   * subscription; the returned function detaches this callback (and
   * unsubscribes on the wire when it was the last one). Registered
   * subscriptions survive reconnects — they are replayed on every open.
   */
  subscribe<T>(topic: string, type: string, cb: (msg: T) => void, opts: { throttleRate?: number } = {}): () => void {
    let entry = this.subs.get(topic)
    if (!entry) {
      entry = {
        type,
        id: this.nextId('subscribe', topic),
        callbacks: new Set(),
        ...(opts.throttleRate !== undefined ? { throttleRate: opts.throttleRate } : {}),
      }
      this.subs.set(topic, entry)
      if (this.isConnected()) this.sendSubscribe(topic, entry)
    }
    const callback = cb as (msg: unknown) => void
    entry.callbacks.add(callback)
    return () => {
      const cur = this.subs.get(topic)
      if (!cur) return
      cur.callbacks.delete(callback)
      if (cur.callbacks.size === 0) {
        this.subs.delete(topic)
        if (this.isConnected()) this.send({ op: 'unsubscribe', id: cur.id, topic })
      }
    }
  }

  /** Announce intent to publish on a topic (required before publish). */
  advertise(topic: string, type: string): void {
    if (this.adverts.has(topic)) return
    const entry = { type, id: this.nextId('advertise', topic) }
    this.adverts.set(topic, entry)
    if (this.isConnected()) this.send({ op: 'advertise', id: entry.id, topic, type })
  }

  unadvertise(topic: string): void {
    const entry = this.adverts.get(topic)
    if (!entry) return
    this.adverts.delete(topic)
    if (this.isConnected()) this.send({ op: 'unadvertise', id: entry.id, topic })
  }

  /** Publish one message. Throws unless advertised and currently connected —
   * callers own the decision of what a dropped command means. */
  publish(topic: string, msg: unknown): void {
    if (!this.adverts.has(topic)) throw new Error(`publish on ${topic} without advertise`)
    if (!this.isConnected()) throw new Error(`rosbridge is not connected (status: ${this.status})`)
    this.send({ op: 'publish', id: this.nextId('publish', topic), topic, msg })
  }

  /** Call a ROS service; resolves with the response values. */
  callService<TRes = unknown>(service: string, args?: Record<string, unknown>, type?: string): Promise<TRes> {
    if (!this.isConnected()) {
      return Promise.reject(new Error(`rosbridge is not connected (status: ${this.status})`))
    }
    const id = this.nextId('call_service', service)
    return new Promise<TRes>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCalls.delete(id)
        reject(new Error(`service call ${service} timed out after ${this.serviceTimeoutMs} ms`))
      }, this.serviceTimeoutMs)
      this.pendingCalls.set(id, {
        resolve: (values) => resolve(values as TRes),
        reject,
        timer,
      })
      this.send({ op: 'call_service', id, service, ...(type !== undefined ? { type } : {}), ...(args !== undefined ? { args } : {}) })
    })
  }

  // --- Internals -----------------------------------------------------------

  private nextId(op: string, name: string): string {
    return `${op}:${name}:${++this.seq}`
  }

  private send(msg: OutgoingOp): void {
    this.ws?.send(JSON.stringify(msg))
  }

  private sendSubscribe(topic: string, entry: SubscriptionEntry): void {
    this.send({
      op: 'subscribe',
      id: entry.id,
      topic,
      type: entry.type,
      ...(entry.throttleRate !== undefined ? { throttle_rate: entry.throttleRate } : {}),
    })
  }

  /** On every (re)connect: replay all registered subscriptions + adverts. */
  private replayRegistry(): void {
    for (const [topic, entry] of this.subs) this.sendSubscribe(topic, entry)
    for (const [topic, entry] of this.adverts) this.send({ op: 'advertise', id: entry.id, topic, type: entry.type })
  }

  private handleMessage(raw: string): void {
    let msg: IncomingOp
    try {
      msg = JSON.parse(raw) as IncomingOp
    } catch {
      return // not JSON — ignore rather than kill the connection
    }
    switch (msg.op) {
      case 'publish': {
        const entry = this.subs.get(msg.topic)
        if (!entry) return
        for (const cb of entry.callbacks) {
          try {
            cb(msg.msg)
          } catch {
            // A bad handler must not take down the message pump.
          }
        }
        return
      }
      case 'service_response': {
        if (msg.id === undefined) return
        const pending = this.pendingCalls.get(msg.id)
        if (!pending) return
        this.pendingCalls.delete(msg.id)
        clearTimeout(pending.timer)
        if (msg.result) pending.resolve(msg.values)
        else pending.reject(new Error(`service ${msg.service} failed: ${JSON.stringify(msg.values ?? null)}`))
        return
      }
      case 'status': {
        this.onServerStatus?.(msg.level, msg.msg)
        return
      }
      default:
        return // unknown op — forward-compatible ignore
    }
  }

  private rejectAllPending(err: Error): void {
    for (const [, pending] of this.pendingCalls) {
      clearTimeout(pending.timer)
      pending.reject(err)
    }
    this.pendingCalls.clear()
  }

  private scheduleRetry(): void {
    if (this.closedByUser) return
    const delay = Math.min(this.initialBackoffMs * 2 ** Math.max(0, this.attempts - 1), this.maxBackoffMs)
    this.nextRetryMs = delay
    this.clearRetry()
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      if (!this.closedByUser && !this.ws) this.connect()
    }, delay)
  }

  private clearRetry(): void {
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
  }

  private setStatus(status: RosbridgeStatus, detail: string): void {
    this.status = status
    this.onStatus?.(status, detail)
  }
}
