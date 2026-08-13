/**
 * MOCK rosbridge server for Fleetline development and demos.
 *
 * THIS IS A MOCK. It is not ROS, not Gazebo, and not a robot: it is a small
 * Node websocket server that speaks just enough of the rosbridge v2 JSON
 * protocol to exercise Fleetline's ROS BRIDGE mode end to end:
 *
 *   - streams nav_msgs/msg/Odometry at 10 Hz for two simulated robots
 *     (amr_6, amr_7) patrolling waypoint loops laid out to fall inside the
 *     Fleetline warehouse under the console's default coordinate transform
 *     (0.5 m/cell, world origin at grid cell 22, 13);
 *   - streams sensor_msgs/msg/BatteryState (percentage in [0, 1], slow drain)
 *     and a /fleet/status roster (std_msgs/msg/String with a JSON payload);
 *   - accepts geometry_msgs/msg/PoseStamped on /<ns>/goal_pose and steers the
 *     robot straight toward it (no planning, no obstacle avoidance);
 *   - accepts std_msgs/msg/Bool on /<ns>/emergency_stop and freezes/unfreezes
 *     the robot.
 *
 * Protocol ops handled: subscribe, unsubscribe, advertise, unadvertise,
 * publish, call_service (always answered with result:false — no services are
 * mocked). Everything else is ignored, as a permissive real bridge would.
 *
 * Deliberate simplifications (this is a demo prop, not a dynamics model):
 * straight-line motion with instant heading changes, no deconfliction between
 * the two robots, battery numbers are invented drain curves, and odometry is
 * published in the goal frame with zero covariance.
 *
 * Run standalone:  npm run mock-ros   (or: node tools/mock-rosbridge.mjs --port 9090)
 * In tests: import { startMockRosbridge } and pass port 0 for an ephemeral port.
 */

import { WebSocketServer } from 'ws'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

const TAG = '[mock-rosbridge]'

// ---------------------------------------------------------------------------
// Simulated robots
// ---------------------------------------------------------------------------
// World coordinates in meters. With Fleetline's default transform
// (0.5 m/cell, origin at cell (22, 13)) these waypoint loops run along the
// warehouse aisle corridors: y=+2.25 m -> Aisle 2, y=-0.75 m -> Aisle 4,
// y=+0.75 m -> Aisle 3, y=-2.25 m -> Aisle 5; x=±8 m -> the west/east
// transit corridors.

function defaultRobots() {
  return [
    {
      ns: 'amr_6',
      model: '100kg',
      x: -8.0,
      y: 2.25,
      speed: 1.2, // m/s
      battery: 0.84, // fraction, per BatteryState.percentage
      waypoints: [
        { x: 8.0, y: 2.25 },
        { x: 8.0, y: -0.75 },
        { x: -8.0, y: -0.75 },
        { x: -8.0, y: 2.25 },
      ],
    },
    {
      ns: 'amr_7',
      model: '600kg',
      x: 8.0,
      y: -2.25,
      speed: 0.9,
      battery: 0.67,
      waypoints: [
        { x: -8.0, y: -2.25 },
        { x: -8.0, y: 0.75 },
        { x: 8.0, y: 0.75 },
        { x: 8.0, y: -2.25 },
      ],
    },
  ]
}

const ARRIVE_EPS_M = 0.05
const DRAIN_MOVING_PER_S = 0.0005 // 0.05 %/s — an invented, demo-friendly curve
const DRAIN_IDLE_PER_S = 0.00005
const BATTERY_FLOOR = 0.05 // the mock never "dies"; freezing is estop's job

function rosNow() {
  const ms = Date.now()
  return { sec: Math.floor(ms / 1000), nanosec: (ms % 1000) * 1e6 }
}

function yawToQuaternion(yaw) {
  return { x: 0, y: 0, z: Math.sin(yaw / 2), w: Math.cos(yaw / 2) }
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

/**
 * Start the mock server.
 * @param {{ port?: number, tickMs?: number, speedFactor?: number, quiet?: boolean }} opts
 *   port: 0 for an ephemeral port (tests). tickMs: sim/publish period.
 *   speedFactor: multiplies robot speed (test-only fast-forward).
 * @returns {Promise<{ url: string, port: number, robots: object[], clientCount: () => number, close: () => Promise<void> }>}
 */
export function startMockRosbridge(opts = {}) {
  const { port = 9090, tickMs = 100, speedFactor = 1, quiet = true } = opts
  const robots = defaultRobots().map((r) => ({
    ...r,
    wpIndex: 0,
    goal: null, // operator goal overrides the patrol loop; robot holds on arrival
    holding: false,
    frozen: false,
    vx: 0,
    vy: 0,
    yaw: 0,
  }))

  // Default host (dual-stack) so both ws://localhost and ws://127.0.0.1 work.
  const wss = new WebSocketServer({ port })
  /** topic -> Set<ws> */
  const subs = new Map()
  const log = (...args) => {
    if (!quiet) console.log(TAG, ...args)
  }

  function robotByTopic(topic, suffix) {
    const m = new RegExp(`^/([^/]+)/${suffix}$`).exec(topic)
    return m ? robots.find((r) => r.ns === m[1]) : undefined
  }

  function sendTo(ws, obj) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj))
  }

  function broadcast(topic, msg) {
    const set = subs.get(topic)
    if (!set || set.size === 0) return
    const frame = JSON.stringify({ op: 'publish', topic, msg })
    for (const ws of set) {
      if (ws.readyState === ws.OPEN) ws.send(frame)
    }
  }

  wss.on('connection', (ws) => {
    log('client connected')
    ws.on('message', (raw) => {
      let msg
      try {
        msg = JSON.parse(raw.toString())
      } catch {
        sendTo(ws, { op: 'status', level: 'error', msg: 'mock: message is not valid JSON' })
        return
      }
      switch (msg.op) {
        case 'subscribe': {
          if (typeof msg.topic !== 'string') return
          if (!subs.has(msg.topic)) subs.set(msg.topic, new Set())
          subs.get(msg.topic).add(ws)
          log(`subscribe ${msg.topic}`)
          return
        }
        case 'unsubscribe': {
          subs.get(msg.topic)?.delete(ws)
          return
        }
        case 'advertise':
        case 'unadvertise':
          return // accepted, nothing to track for a mock
        case 'publish':
          handleIncomingPublish(msg)
          return
        case 'call_service':
          sendTo(ws, {
            op: 'service_response',
            id: msg.id,
            service: msg.service,
            values: { message: 'mock-rosbridge implements no services' },
            result: false,
          })
          return
        default:
          return
      }
    })
    ws.on('close', () => {
      for (const set of subs.values()) set.delete(ws)
      log('client disconnected')
    })
  })

  function handleIncomingPublish(msg) {
    const goalBot = robotByTopic(msg.topic, 'goal_pose')
    if (goalBot) {
      const p = msg.msg?.pose?.position
      if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) {
        goalBot.goal = { x: p.x, y: p.y }
        goalBot.holding = false
        log(`${goalBot.ns}: goal_pose (${p.x.toFixed(2)}, ${p.y.toFixed(2)})`)
      }
      return
    }
    const estopBot = robotByTopic(msg.topic, 'emergency_stop')
    if (estopBot && typeof msg.msg?.data === 'boolean') {
      estopBot.frozen = msg.msg.data
      log(`${estopBot.ns}: emergency_stop ${estopBot.frozen}`)
    }
  }

  // --- Simulation + publication loop --------------------------------------

  let tickCount = 0
  const timer = setInterval(() => {
    const dt = (tickMs / 1000) * speedFactor
    tickCount++
    for (const r of robots) {
      let speed = 0
      if (!r.frozen && !r.holding) {
        const target = r.goal ?? r.waypoints[r.wpIndex]
        const dx = target.x - r.x
        const dy = target.y - r.y
        const dist = Math.hypot(dx, dy)
        if (dist <= ARRIVE_EPS_M) {
          if (r.goal) {
            log(`${r.ns}: reached goal, holding`)
            r.goal = null
            r.holding = true // an operator goal ends the patrol; hold there
          } else {
            r.wpIndex = (r.wpIndex + 1) % r.waypoints.length
          }
        } else {
          const step = Math.min(r.speed * dt, dist)
          r.x += (dx / dist) * step
          r.y += (dy / dist) * step
          r.yaw = Math.atan2(dy, dx)
          speed = r.speed
        }
      }
      r.vx = speed // body-frame forward speed (see odometry note below)
      r.vy = 0
      r.battery = Math.max(BATTERY_FLOOR, r.battery - (speed > 0 ? DRAIN_MOVING_PER_S : DRAIN_IDLE_PER_S) * dt)

      // nav_msgs/msg/Odometry. Mock simplification: pose is exact in the
      // goal frame; twist.linear.x is the forward (body-frame) speed.
      broadcast(`/${r.ns}/odom`, {
        header: { stamp: rosNow(), frame_id: 'odom' },
        child_frame_id: `${r.ns}/base_link`,
        pose: {
          pose: {
            position: { x: r.x, y: r.y, z: 0 },
            orientation: yawToQuaternion(r.yaw),
          },
          covariance: new Array(36).fill(0),
        },
        twist: {
          twist: {
            linear: { x: r.vx, y: r.vy, z: 0 },
            angular: { x: 0, y: 0, z: 0 },
          },
          covariance: new Array(36).fill(0),
        },
      })

      if (tickCount % 10 === 1) {
        // sensor_msgs/msg/BatteryState — invented but shaped like a 7S LiPo.
        broadcast(`/${r.ns}/battery_state`, {
          header: { stamp: rosNow(), frame_id: '' },
          voltage: 21.0 + 8.4 * r.battery,
          percentage: r.battery,
          current: speed > 0 ? -6.5 : -0.8,
          charge: 40 * r.battery,
          capacity: 40,
          design_capacity: 40,
          power_supply_status: 2, // DISCHARGING
          power_supply_health: 1, // GOOD
          power_supply_technology: 3, // LIPO
          present: true,
          location: 'main_bay',
          serial_number: `MOCK-${r.ns.toUpperCase()}`,
        })
      }
    }

    if (tickCount % 10 === 1) {
      // Roster stand-in: ROS 2 has no standard fleet-state message, so the
      // mock (like the console) uses std_msgs/String with a JSON payload.
      broadcast('/fleet/status', {
        data: JSON.stringify({ robots: robots.map((r) => ({ ns: r.ns, model: r.model })) }),
      })
    }
  }, tickMs)

  return new Promise((resolve, reject) => {
    wss.on('error', reject)
    wss.on('listening', () => {
      const actualPort = wss.address().port
      resolve({
        url: `ws://127.0.0.1:${actualPort}`,
        port: actualPort,
        robots,
        clientCount: () => wss.clients.size,
        close: () =>
          new Promise((res) => {
            clearInterval(timer)
            for (const ws of wss.clients) ws.terminate()
            wss.close(() => res())
          }),
      })
    })
  })
}

// ---------------------------------------------------------------------------
// Standalone entry point
// ---------------------------------------------------------------------------

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href

if (isMain) {
  const portArg = process.argv.indexOf('--port')
  const port = portArg >= 0 ? Number(process.argv[portArg + 1]) : 9090
  startMockRosbridge({ port, quiet: false })
    .then((server) => {
      console.log(`${TAG} ================================================================`)
      console.log(`${TAG} MOCK rosbridge server — NOT a real ROS system`)
      console.log(`${TAG} Speaking a subset of the rosbridge v2 JSON protocol on ${server.url}`)
      console.log(`${TAG} Robots: amr_6 (100kg), amr_7 (600kg) patrolling the aisle loops`)
      console.log(`${TAG} Accepts /<ns>/goal_pose (PoseStamped) and /<ns>/emergency_stop (Bool)`)
      console.log(`${TAG} Point Fleetline at it: ?source=ros&bridge=${server.url.replace('127.0.0.1', 'localhost')}`)
      console.log(`${TAG} ================================================================`)
    })
    .catch((err) => {
      console.error(`${TAG} failed to start:`, err.message)
      process.exit(1)
    })
}
