/**
 * Fleet roster (left panel): one compact card per AMR.
 *
 * Cards are real <button>s so the whole fleet is keyboard-walkable: Tab
 * through robots, Enter/Space to select. Selection highlights the robot on
 * the map and opens the detail drawer. aria-pressed mirrors selection.
 */

import { useSyncExternalStore } from 'react'
import { fleetStore } from '../store'
import type { Robot } from '../sim/robot'
import { ROBOT_CLASS_SPECS } from '../sim/robot'
import { taskProgress } from '../derive'
import { BatteryBar, ProgressBar, StateChip } from './bits'

function taskLine(r: Robot): string {
  const rosMode = fleetStore.dataSource === 'ros'
  const task = r.taskId ? fleetStore.sim.queue.get(r.taskId) : undefined
  if (task) return `${task.id} · ${task.rackRow} → ${task.stationName}`
  switch (r.state) {
    case 'charging':
      return `Charging at ${r.chargerName ?? 'bay'}`
    case 'estopped':
      return 'Halted — e-stop'
    case 'awaiting_help':
      return 'Awaiting operator decision'
    case 'moving':
      return r.mission?.kind === 'charge'
        ? `To ${r.mission.label ?? 'charger'}`
        : r.mission?.kind === 'goto'
          ? `To ${r.mission.label ?? 'station'} (operator)`
          : r.mission?.kind === 'staging'
            ? 'To STAGING'
            : rosMode
              ? 'Live telemetry · no task feed' // bridge has no fleet manager
              : 'Repositioning'
    default:
      if (r.waitingForCharger) return 'Waiting for a charge bay'
      return rosMode ? 'Live telemetry · no task feed' : 'No task'
  }
}

function RosterCard({ r }: { r: Robot }) {
  const selected = fleetStore.selectedRobotId === r.id
  const progress = taskProgress(r)
  return (
    <button
      type="button"
      className={`rcard ${selected ? 'rcard-sel' : ''}`}
      aria-pressed={selected}
      onClick={() => fleetStore.selectRobot(selected ? null : r.id)}
    >
      <span className="rcard-top">
        <span className="rid">{r.id}</span>
        <span className="rclass">{ROBOT_CLASS_SPECS[r.cls].label}</span>
        <StateChip state={r.state} />
      </span>
      <span className="rcard-task">{taskLine(r)}</span>
      <BatteryBar pct={r.battery} />
      {progress !== null && <ProgressBar fraction={progress} label={`Task progress for ${r.id}`} />}
    </button>
  )
}

export default function Roster() {
  useSyncExternalStore(fleetStore.subscribe, fleetStore.getSnapshot)
  const robots = fleetStore.sim.robots
  const rosMode = fleetStore.dataSource === 'ros'
  const active = robots.filter((r) => r.state === 'moving' || r.state === 'executing').length
  return (
    <div className="roster">
      <header className="panel-head">
        <h2>FLEET</h2>
        <span className="panel-sub">
          {robots.length} units · {active} active{rosMode ? ' · live' : ''}
        </span>
      </header>
      <div className="roster-list">
        {robots.length === 0 ? (
          <div className="roster-empty">
            {rosMode
              ? 'No robots discovered yet — the roster fills as robots publish on the bridge (/fleet/status + odometry).'
              : 'No robots in the fleet.'}
          </div>
        ) : (
          robots.map((r) => <RosterCard key={r.id} r={r} />)
        )}
      </div>
    </div>
  )
}
