/**
 * Type declarations for the mock rosbridge server (tools/mock-rosbridge.mjs)
 * so the vitest integration suite can import it under `tsc -b`.
 */

export interface MockRobot {
  ns: string
  model: string
  x: number
  y: number
  speed: number
  battery: number
  wpIndex: number
  goal: { x: number; y: number } | null
  holding: boolean
  frozen: boolean
  vx: number
  vy: number
  yaw: number
  waypoints: Array<{ x: number; y: number }>
}

export interface MockRosbridge {
  url: string
  port: number
  robots: MockRobot[]
  clientCount(): number
  close(): Promise<void>
}

export function startMockRosbridge(opts?: {
  port?: number
  tickMs?: number
  speedFactor?: number
  quiet?: boolean
}): Promise<MockRosbridge>
