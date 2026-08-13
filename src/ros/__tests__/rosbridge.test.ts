/**
 * Integration: the hand-rolled rosbridge client against the in-process mock
 * rosbridge server (tools/mock-rosbridge.mjs) on an ephemeral port.
 *
 * Covers the wire protocol round trip: subscribe -> streamed odometry,
 * advertise + publish goal_pose -> mock robot converges toward the goal,
 * publish emergency_stop -> robot freezes, unsubscribe stops delivery, and
 * reconnect-with-backoff replays the subscription registry.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { startMockRosbridge } from '../../../tools/mock-rosbridge.mjs'
import type { MockRosbridge } from '../../../tools/mock-rosbridge.mjs'
import { RosbridgeClient } from '../rosbridge'
import type { RosbridgeStatus } from '../rosbridge'
import type { Odometry, PoseStamped } from '../messages'
import { MSG_TYPES, rosNow } from '../messages'

/** Poll until `fn` returns truthy or the deadline passes. */
async function until<T>(fn: () => T, timeoutMs = 5000, label = 'condition'): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const v = fn()
    if (v) return v as NonNullable<T>
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await new Promise((r) => setTimeout(r, 20))
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function goalMsg(x: number, y: number): PoseStamped {
  return {
    header: { stamp: rosNow(), frame_id: 'map' },
    pose: { position: { x, y, z: 0 }, orientation: { x: 0, y: 0, z: 0, w: 1 } },
  }
}

describe('rosbridge client <-> mock server', () => {
  let server: MockRosbridge | null = null
  let client: RosbridgeClient | null = null

  afterEach(async () => {
    client?.close()
    client = null
    await server?.close()
    server = null
  })

  async function connect(opts: { tickMs?: number; speedFactor?: number } = {}): Promise<{ server: MockRosbridge; client: RosbridgeClient }> {
    server = await startMockRosbridge({ port: 0, ...opts })
    const statuses: RosbridgeStatus[] = []
    client = new RosbridgeClient(server.url, {
      initialBackoffMs: 150,
      onStatus: (s) => statuses.push(s),
    })
    client.connect()
    await until(() => client!.status === 'connected', 5000, 'connected status')
    expect(statuses).toContain('connecting')
    expect(statuses).toContain('connected')
    return { server, client }
  }

  it('subscribes and receives streaming odometry with changing pose', async () => {
    const { client } = await connect({ tickMs: 20 })
    const received: Odometry[] = []
    client.subscribe<Odometry>('/amr_6/odom', MSG_TYPES.odometry, (m) => received.push(m))

    await until(() => received.length >= 5, 5000, 'five odometry messages')
    const first = received[0]
    const last = received[received.length - 1]
    // Message shape matches nav_msgs/msg/Odometry
    expect(first.header.frame_id).toBe('odom')
    expect(first.child_frame_id).toBe('amr_6/base_link')
    expect(typeof first.pose.pose.position.x).toBe('number')
    expect(typeof first.twist.twist.linear.x).toBe('number')
    // The robot is patrolling: pose changes between messages
    const moved = Math.hypot(
      last.pose.pose.position.x - first.pose.pose.position.x,
      last.pose.pose.position.y - first.pose.pose.position.y,
    )
    expect(moved).toBeGreaterThan(0)
  })

  it('publishes a goal_pose and the mock robot converges toward it', async () => {
    const { server, client } = await connect({ tickMs: 20, speedFactor: 5 })
    const bot = server.robots.find((r) => r.ns === 'amr_6')!
    const goal = { x: bot.x + 1.5, y: bot.y + 0.5 }
    const startDist = Math.hypot(goal.x - bot.x, goal.y - bot.y)

    client.advertise('/amr_6/goal_pose', MSG_TYPES.poseStamped)
    client.publish('/amr_6/goal_pose', goalMsg(goal.x, goal.y))

    await until(() => bot.goal !== null || bot.holding, 3000, 'mock accepted the goal')
    await until(
      () => Math.hypot(goal.x - bot.x, goal.y - bot.y) < 0.2,
      5000,
      'robot converged on the goal',
    )
    expect(Math.hypot(goal.x - bot.x, goal.y - bot.y)).toBeLessThan(startDist)
    // Reaching an operator goal ends the patrol: the robot holds there.
    await until(() => bot.holding, 3000, 'robot holding at goal')
  })

  it('publishing before advertise throws (protocol order is enforced)', async () => {
    const { client } = await connect()
    expect(() => client.publish('/amr_6/goal_pose', goalMsg(0, 0))).toThrow(/advertise/)
  })

  it('emergency_stop freezes the robot; releasing it resumes motion', async () => {
    const { server, client } = await connect({ tickMs: 20 })
    const bot = server.robots.find((r) => r.ns === 'amr_7')!
    client.advertise('/amr_7/emergency_stop', MSG_TYPES.bool)

    client.publish('/amr_7/emergency_stop', { data: true })
    await until(() => bot.frozen, 3000, 'mock frozen flag')
    const frozenAt = { x: bot.x, y: bot.y }
    await sleep(300)
    expect(bot.x).toBe(frozenAt.x)
    expect(bot.y).toBe(frozenAt.y)
    expect(bot.vx).toBe(0)

    client.publish('/amr_7/emergency_stop', { data: false })
    await until(
      () => Math.hypot(bot.x - frozenAt.x, bot.y - frozenAt.y) > 0.05,
      5000,
      'robot moving again after release',
    )
  })

  it('unsubscribe stops message delivery', async () => {
    const { client } = await connect({ tickMs: 20 })
    let count = 0
    const unsubscribe = client.subscribe<Odometry>('/amr_6/odom', MSG_TYPES.odometry, () => count++)
    await until(() => count >= 3, 5000, 'first deliveries')
    unsubscribe()
    await sleep(100) // drain anything in flight
    const after = count
    await sleep(300)
    expect(count).toBe(after)
  })

  it('reconnects with backoff and replays subscriptions after the server restarts', async () => {
    const { client } = await connect({ tickMs: 20 })
    let count = 0
    client.subscribe<Odometry>('/amr_6/odom', MSG_TYPES.odometry, () => count++)
    await until(() => count >= 2, 5000, 'initial stream')

    const port = server!.port
    await server!.close()
    server = null
    await until(() => client.status === 'error', 5000, 'error status after server loss')

    // Same port, fresh server: the client must reconnect on its own and
    // replay the subscription registry (no re-subscribe call here).
    server = await startMockRosbridge({ port, tickMs: 20 })
    await until(() => client.status === 'connected', 10_000, 'automatic reconnect')
    const before = count
    await until(() => count > before + 2, 5000, 'stream resumed after reconnect')
  })

  it('answers call_service with an id-matched service_response', async () => {
    const { client } = await connect()
    // The mock implements no services and says so — the failure path proves
    // the request/response id matching works.
    await expect(client.callService('/rosapi/topics')).rejects.toThrow(/no services/)
  })
})
