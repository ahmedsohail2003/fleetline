/**
 * Guided-demo script: a ~60 second scripted tour of the console with
 * narration captions.
 *
 * Honesty contract (same rule as everything else in Fleetline): the demo has
 * no special powers. Every action goes through the exact operator APIs the
 * UI uses — tasks enter the real queue, the help request is the sim's own
 * injection path, the chat sentence is typed through the real command
 * pipeline (grammar parser -> executor, GRAMMAR provenance chip and all),
 * and the e-stop is the same `estopAll` the red button calls. The script is
 * data + pure helpers so the sequence/timing can be unit-tested against the
 * real simulation (see __tests__/script.test.ts).
 *
 * The demo runs on the live sim (it does not reset the shift), so target
 * selection is defensive: helpers pick a robot that can actually host the
 * help request / accept the command at that moment.
 */

import type { FleetStore } from '../store'
import type { FleetSim } from '../sim/sim'
import type { Robot } from '../sim/robot'
import type { TaskPriority } from '../sim/tasks'
import type { RobotClass } from '../sim/robot'
import { PICK_SPOTS } from '../sim/warehouse'

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

export type DemoActionKind =
  | 'spawn-tasks' // enqueue three fixed pick tasks; the fleet self-assigns
  | 'inject-help' // fire a PATH_BLOCKED help request on a moving robot
  | 'resolve-help' // resolve that request with "Reroute" (auto-decided)
  | 'chat' // auto-type a natural-language command through the console
  | 'estop-all' // global e-stop (same API as the red button)
  | 'release-estop' // release it (the UI itself requires a two-step confirm)

export interface DemoStep {
  /** Narration caption shown for the whole step. */
  caption: string
  /** Step duration; the next step begins when it elapses. */
  durMs: number
  /** Action performed (through the real operator APIs) when the step starts. */
  action?: DemoActionKind
}

/** Keystroke interval for the auto-typed chat command (visible typing). */
export const TYPE_MS_PER_CHAR = 55
/** Pause between the last keystroke and submit, so the sentence is readable. */
export const TYPE_SUBMIT_PAUSE_MS = 400

/** The station the demo's chat command dispatches to. */
export const CHAT_STATION = 'PACK-1'
/** The robot the demo prefers to address by name (matches the caption). */
export const PREFERRED_CHAT_ROBOT = 'AMR-2'

export const DEMO_STEPS: DemoStep[] = [
  {
    caption:
      'Guided demo — 60 seconds, scripted actions on the live simulation. Captions narrate; press Esc or interact anywhere to take over at any point.',
    durMs: 5000,
  },
  {
    caption:
      'Orders arrive: three pick tasks join the queue. Nobody dispatches robots by hand — the fleet self-assigns by priority, distance, and payload class.',
    durMs: 7000,
    action: 'spawn-tasks',
  },
  {
    caption:
      'The robots plan their own paths and yield to each other in the aisles. Supervised autonomy: the fleet works, the operator watches for exceptions.',
    durMs: 7000,
  },
  {
    caption:
      'An exception — a robot finds its aisle blocked and asks for help. The amber card in INTERVENTIONS never steals focus: triage stays on your terms.',
    durMs: 6000,
    action: 'inject-help',
  },
  {
    caption:
      'Every request carries a closed set of resolutions with consequences spelled out. The demo picks REROUTE — the robot replans around the obstruction.',
    durMs: 7000,
    action: 'resolve-help',
  },
  {
    caption:
      'The second command modality: plain language. Watch the command console below — the grammar parser turns the sentence into the same command API the map uses.',
    durMs: 9000,
    action: 'chat',
  },
  {
    caption:
      'When something looks wrong there is one answer: E-STOP. One click halts the entire fleet — safety actions are never gated behind a confirmation.',
    durMs: 6000,
    action: 'estop-all',
  },
  {
    caption:
      'Releasing is deliberately harder — restarting a moving fleet is the consequential action, so the console demands a two-step confirm (the demo has just performed it).',
    durMs: 7000,
    action: 'release-estop',
  },
  {
    caption:
      'That is the loop: monitor, get asked, decide, command — by click, sentence, or voice. The console is yours: select a robot, press / to type, or open ? for the rationale.',
    durMs: 6000,
  },
]

export const DEMO_TOTAL_MS = DEMO_STEPS.reduce((s, st) => s + st.durMs, 0)

/** Millisecond offset from demo start at which step `index` begins. */
export function stepStartMs(index: number): number {
  return DEMO_STEPS.slice(0, index).reduce((s, st) => s + st.durMs, 0)
}

// ---------------------------------------------------------------------------
// Target selection (defensive — the demo runs on whatever the sim is doing)
// ---------------------------------------------------------------------------

/**
 * Robot to fire the PATH_BLOCKED request on: a moving robot with enough path
 * ahead to host an obstruction. Prefers one that is not the chat-step robot
 * so the story involves more of the fleet. Null when nothing qualifies (the
 * runner then skips the injection — captions still play).
 */
export function pickHelpTarget(sim: FleetSim): string | null {
  const candidates = sim.robots.filter(
    (r) => r.state === 'moving' && r.path.length - r.pathIndex >= 4 && !sim.openHelpFor(r.id),
  )
  if (candidates.length === 0) return null
  const preferred = candidates.filter((r) => r.id !== PREFERRED_CHAT_ROBOT)
  const pool = preferred.length > 0 ? preferred : candidates
  // Longest remaining path = most legible reroute on the map.
  pool.sort((a, b) => b.path.length - b.pathIndex - (a.path.length - a.pathIndex))
  return pool[0].id
}

/** Whether `commandGoto` would accept a station command for this robot now
 * (mirrors the sim's commandBlockReason). */
function isCommandable(r: Robot): boolean {
  if (r.state === 'estopped' || r.state === 'awaiting_help' || r.state === 'executing') return false
  if (r.phase === 'to_drop') return false
  return true
}

/**
 * Robot the chat step addresses: AMR-2 when it can take the command (the
 * canonical demo sentence), otherwise the first robot that can — the typed
 * sentence adapts so the demo shows an accepted command, not a refusal.
 */
export function pickChatRobot(sim: FleetSim): string {
  const preferred = sim.robots.find((r) => r.id === PREFERRED_CHAT_ROBOT)
  if (preferred && isCommandable(preferred)) return preferred.id
  const other = sim.robots.find((r) => isCommandable(r) && r.state !== 'charging')
  if (other) return other.id
  const any = sim.robots.find((r) => isCommandable(r))
  return any?.id ?? PREFERRED_CHAT_ROBOT
}

/** The sentence the demo types into the command console. */
export function chatSentence(sim: FleetSim): string {
  return `send ${pickChatRobot(sim)} to ${CHAT_STATION}`
}

// ---------------------------------------------------------------------------
// Actions (everything except 'chat', which the console types for itself)
// ---------------------------------------------------------------------------

/** Fixed, legible demo tasks: three racks spread across the map, three
 * different destinations, one high-priority. All carryable by any class. */
function demoTaskParams(): Array<{
  rackRow: string
  stationName: string
  requiredClass: RobotClass
  priority: TaskPriority
}> {
  return [
    { rackRow: 'R1', stationName: 'PACK-1', requiredClass: '100kg', priority: 1 },
    { rackRow: 'R3', stationName: 'PACK-2', requiredClass: '100kg', priority: 2 },
    { rackRow: 'R5', stationName: 'RECEIVING', requiredClass: '600kg', priority: 2 },
  ]
}

/** Mutable context threaded through a demo run (which request we opened). */
export interface DemoRunContext {
  helpId: string | null
}

/**
 * Perform a non-chat demo action through the store's operator APIs.
 * Returns false when the action had nothing valid to act on (skipped).
 */
export function applyDemoAction(store: FleetStore, kind: Exclude<DemoActionKind, 'chat'>, ctx: DemoRunContext): boolean {
  const sim = store.sim
  switch (kind) {
    case 'spawn-tasks': {
      for (const p of demoTaskParams()) {
        const spots = PICK_SPOTS.filter((s) => s.rackRow === p.rackRow)
        const spot = spots[Math.floor(spots.length / 2)]
        if (!spot) continue
        sim.enqueueTask({
          pickRack: spot.rack,
          pickApproach: spot.approach,
          rackRow: spot.rackRow,
          stationName: p.stationName,
          requiredClass: p.requiredClass,
          priority: p.priority,
        })
      }
      return true
    }
    case 'inject-help': {
      const target = pickHelpTarget(sim)
      if (!target) return false
      const help = sim.injectHelpRequest(target, 'PATH_BLOCKED')
      ctx.helpId = help?.id ?? null
      return ctx.helpId !== null
    }
    case 'resolve-help': {
      if (!ctx.helpId) return false
      const help = sim.help.find((h) => h.id === ctx.helpId)
      if (!help || help.state !== 'open') return false
      store.resolveHelp(ctx.helpId, 'reroute')
      return true
    }
    case 'estop-all': {
      store.estopAll()
      return true
    }
    case 'release-estop': {
      store.resumeAll()
      return true
    }
  }
}
