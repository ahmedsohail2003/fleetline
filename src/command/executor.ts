/**
 * Command executor: turns a typed `Command` into fleet actions through the
 * same store/sim API the direct-manipulation UI uses (source: 'chat'), and
 * returns operator-facing result lines for the response bubble.
 *
 * Safety layer lives here too: `isDestructive` gates which commands the
 * console must hold behind an inline confirmation (global e-stop, releasing
 * it, and aborting tasks — actions that halt the whole fleet, start the whole
 * fleet, or destroy work). Everything executed or refused ends up in the
 * event log tagged as an operator action.
 */

import type { FleetStore } from '../store'
import type { FleetSim } from '../sim/sim'
import type { Robot } from '../sim/robot'
import { AISLES } from '../sim/warehouse'
import { ROBOT_STATE_META } from '../derive'
import type { Command, RobotScope } from './types'

export interface ExecLine {
  ok: boolean
  text: string
}

export interface ExecOutcome {
  lines: ExecLine[]
  /** Short summary for spoken confirmation (speechSynthesis). */
  speech: string
}

// ---------------------------------------------------------------------------
// Descriptions ("what was understood") and safety metadata
// ---------------------------------------------------------------------------

function scopePhrase(scope: RobotScope): string {
  switch (scope.type) {
    case 'all':
      return 'every robot'
    case 'aisle':
      return `all robots currently in Aisle ${scope.aisle}`
    case 'robots':
      return scope.ids.join(' and ')
  }
}

/** One human sentence restating the command — rendered in the response
 * bubble so the operator can verify the interpretation before/after it runs. */
export function describeCommand(cmd: Command): string {
  switch (cmd.kind) {
    case 'send':
      return `Send ${cmd.robotIds.join(' and ')} to ${cmd.station}.`
    case 'charge':
      return `Send ${cmd.robotIds.join(' and ')} to ${cmd.bay ?? 'the nearest free charge bay'}.`
    case 'pause':
      return `Soft-stop ${scopePhrase(cmd.scope)}.`
    case 'resume':
      return `Resume ${scopePhrase(cmd.scope)}.`
    case 'reroute':
      return `Replan the route for ${cmd.robotIds.join(' and ')}.`
    case 'status':
      return cmd.robotIds.length > 0 ? `Status report for ${cmd.robotIds.join(' and ')}.` : 'Fleet status report.'
    case 'abort_task':
      return `Abort the active task on ${cmd.robotIds.join(' and ')}.`
    case 'estop_all':
      return 'EMERGENCY STOP the entire fleet.'
    case 'clear_estop':
      return 'Release the global e-stop and resume the fleet.'
    case 'help':
      return 'Show available commands.'
  }
}

/**
 * Destructive commands require an inline confirmation in the console before
 * executing. Note the deliberate asymmetry with the physical E-STOP button
 * (one click, never confirmed): a button press is unambiguous operator
 * intent, while a parsed sentence — especially a voice transcript — carries
 * interpretation risk, so fleet-wide halts, fleet-wide releases, and
 * unrecoverable task aborts get one cheap verification click.
 */
export function isDestructive(cmd: Command): boolean {
  return cmd.kind === 'estop_all' || cmd.kind === 'clear_estop' || cmd.kind === 'abort_task'
}

/** Consequence sentence shown next to the CONFIRM button. */
export function confirmationPrompt(store: FleetStore, cmd: Command): string {
  const sim = store.sim
  const ros = store.dataSource === 'ros'
  switch (cmd.kind) {
    case 'estop_all':
      return ros
        ? `This immediately publishes emergency_stop to all ${sim.robots.length} robots on the bridge.`
        : `This immediately halts all ${sim.robots.length} robots and pauses task dispatch.`
    case 'clear_estop': {
      const held = sim.robots.filter((r) => r.state === 'estopped' && r.estopOrigin === 'individual')
      const count = held.length > 0 ? `${sim.robots.length - held.length} of ${sim.robots.length}` : `all ${sim.robots.length}`
      const holdNote =
        held.length > 0 ? ` ${held.map((r) => r.id).join(' and ')} will stay halted under individual e-stop.` : ''
      return ros
        ? `This publishes the e-stop release to ${count} robots on the bridge — they resume on their own.${holdNote}`
        : `This releases the global e-stop — ${count} robots resume their previous activity.${holdNote}`
    }
    case 'abort_task': {
      const parts = cmd.robotIds.map((id) => {
        const r = sim.getRobot(id)
        return r.taskId ? `${r.taskId} on ${id}` : `${id} (no active task)`
      })
      return `This permanently cancels ${parts.join(' and ')} — aborted tasks are not requeued.`
    }
    default:
      return ''
  }
}

/**
 * Contextual rewrite before the safety gate: "resume all" while the global
 * e-stop is latched is really a request to release it, which is the
 * consequential (confirm-gated) action per the console's e-stop design.
 */
export function effectiveCommand(store: FleetStore, cmd: Command): Command {
  if (cmd.kind === 'resume' && cmd.scope.type === 'all' && store.sim.globalEstop) {
    return { kind: 'clear_estop' }
  }
  return cmd
}

// ---------------------------------------------------------------------------
// Scope resolution
// ---------------------------------------------------------------------------

/** Robots whose current cell lies inside the aisle's corridor rectangle. */
export function robotsInAisle(sim: FleetSim, aisle: number): Robot[] {
  const a = AISLES[aisle - 1]
  if (!a) return []
  return sim.robots.filter((r) => r.gy >= a.y0 && r.gy <= a.y1 && r.gx >= a.x0 && r.gx <= a.x1)
}

function resolveScope(sim: FleetSim, scope: RobotScope): string[] {
  switch (scope.type) {
    case 'all':
      return sim.robots.map((r) => r.id)
    case 'aisle':
      return robotsInAisle(sim, scope.aisle).map((r) => r.id)
    case 'robots':
      return scope.ids
  }
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

function emptyScopeText(scope: RobotScope): string {
  return scope.type === 'aisle' ? `No robots are currently in Aisle ${scope.aisle}` : 'No robots matched that command'
}

function speechFor(lines: ExecLine[]): string {
  if (lines.length === 0) return 'No action taken.'
  if (lines.length === 1) return lines[0].text
  const ok = lines.filter((l) => l.ok).length
  const refused = lines.length - ok
  return `${ok} of ${lines.length} actions completed${refused > 0 ? `, ${refused} refused` : ''}.`
}

function outcome(lines: ExecLine[]): ExecOutcome {
  return { lines, speech: speechFor(lines) }
}

function statusLine(sim: FleetSim, r: Robot): string {
  const state = ROBOT_STATE_META[r.state].label
  const task = r.taskId ? sim.queue.get(r.taskId) : undefined
  const doing = task
    ? `${task.id} → ${task.stationName}`
    : r.state === 'charging'
      ? `docked at ${r.chargerName ?? 'a charge bay'}`
      : r.mission?.label
        ? `en route to ${r.mission.label}`
        : 'no active task'
  return `${r.id} — ${state} · battery ${Math.round(r.battery)}% · ${doing} · cell (${r.gx}, ${r.gy})`
}

/**
 * Execute a (confirmed, if destructive) command against the fleet. Every
 * mutating path either goes through a sim command method that logs itself
 * with source 'chat', or appends an explicit operator-tagged log line here.
 */
export function executeCommand(store: FleetStore, cmd: Command): ExecOutcome {
  const sim = store.sim
  switch (cmd.kind) {
    case 'send':
      return outcome(
        cmd.robotIds.map((id) => {
          const res = store.commandStation(id, cmd.station, 'chat')
          return { ok: res.ok, text: res.ok ? `${id} dispatched to ${cmd.station}` : res.reason ?? 'Command refused' }
        }),
      )

    case 'charge':
      return outcome(
        cmd.robotIds.map((id) => {
          const res = store.commandCharge(id, 'chat', cmd.bay)
          return {
            ok: res.ok,
            text: res.ok ? `${id} sent to ${cmd.bay ?? 'the nearest free charge bay'}` : res.reason ?? 'Command refused',
          }
        }),
      )

    case 'pause': {
      const ids = resolveScope(sim, cmd.scope)
      if (ids.length === 0) {
        return outcome([{ ok: false, text: emptyScopeText(cmd.scope) }])
      }
      store.logOperator(`soft-stop ${scopePhrase(cmd.scope)} (${ids.join(', ')})`)
      return outcome(
        ids.map((id) => {
          const r = sim.getRobot(id)
          if (r.state === 'estopped') return { ok: false, text: `${id} is already stopped` }
          store.estopRobot(id)
          return { ok: true, text: `${id} halted — resume with "resume ${id}"` }
        }),
      )
    }

    case 'resume': {
      if (sim.globalEstop) {
        return outcome([
          { ok: false, text: 'The global e-stop is engaged — say "clear e-stop" to resume the fleet' },
        ])
      }
      const ids = resolveScope(sim, cmd.scope)
      if (ids.length === 0) {
        return outcome([{ ok: false, text: emptyScopeText(cmd.scope) }])
      }
      store.logOperator(`resume ${scopePhrase(cmd.scope)} (${ids.join(', ')})`)
      return outcome(
        ids.map((id) => {
          const r = sim.getRobot(id)
          if (r.state !== 'estopped') return { ok: false, text: `${id} is not stopped` }
          store.resumeRobot(id)
          return { ok: true, text: `${id} resuming` }
        }),
      )
    }

    case 'reroute':
      return outcome(
        cmd.robotIds.map((id) => {
          const res = store.commandReroute(id, 'chat')
          return { ok: res.ok, text: res.ok ? `${id} replanning its route` : res.reason ?? 'Command refused' }
        }),
      )

    case 'status': {
      const robots = cmd.robotIds.length > 0 ? cmd.robotIds.map((id) => sim.getRobot(id)) : sim.robots
      store.logOperator(`status query — ${cmd.robotIds.length > 0 ? cmd.robotIds.join(', ') : 'fleet'}`)
      return outcome(robots.map((r) => ({ ok: true, text: statusLine(sim, r) })))
    }

    case 'abort_task':
      return outcome(
        cmd.robotIds.map((id) => {
          const res = store.commandAbortTask(id, 'chat')
          return { ok: res.ok, text: res.ok ? `Task aborted on ${id}` : res.reason ?? 'Command refused' }
        }),
      )

    case 'estop_all': {
      if (sim.globalEstop) {
        return outcome([{ ok: false, text: 'The global e-stop is already engaged' }])
      }
      store.estopAll()
      return outcome([{ ok: true, text: 'GLOBAL E-STOP engaged — all robots halted. Release with "clear e-stop".' }])
    }

    case 'clear_estop': {
      if (!sim.globalEstop) {
        return outcome([{ ok: false, text: 'The global e-stop is not engaged' }])
      }
      const held = sim.robots.filter((r) => r.state === 'estopped' && r.estopOrigin === 'individual')
      store.resumeAll()
      return outcome([
        { ok: true, text: 'Global e-stop released — fleet resuming' },
        ...held.map((r) => ({
          ok: false,
          text: `${r.id} still stopped — its individual e-stop holds, release with "resume ${r.id}"`,
        })),
      ])
    }

    case 'help':
      // The console renders the examples bubble itself; nothing to execute.
      return outcome([])
  }
}
