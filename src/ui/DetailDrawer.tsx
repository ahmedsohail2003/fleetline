/**
 * Robot detail drawer: docked over the bottom of the map while a robot is
 * selected (the map rescales above it — nothing is hidden behind it).
 *
 * Carries the deep-dive data (pose, battery, task history) and the per-robot
 * actions: e-stop/resume, send to charge, send to a named station. The
 * station picker is the keyboard-reachable twin of clicking a station on the
 * map — same command API, same 'direct-manipulation' modality label.
 */

import { useEffect, useState, useSyncExternalStore } from 'react'
import { fleetStore } from '../store'
import type { CommandResult } from '../sim/sim'
import { ROBOT_CLASS_SPECS } from '../sim/robot'
import { STATIONS } from '../sim/warehouse'
import { formatSimClock } from '../sim/events'
import { taskProgress } from '../derive'
import { BatteryBar, ProgressBar, StateChip } from './bits'

const COMMAND_STATIONS = STATIONS.filter((s) => s.kind !== 'charger').map((s) => s.name)

export default function DetailDrawer() {
  useSyncExternalStore(fleetStore.subscribe, fleetStore.getSnapshot)
  const sim = fleetStore.sim
  const rosMode = fleetStore.dataSource === 'ros'
  const r = fleetStore.selectedRobot()
  const selId = r?.id ?? null

  const [stationChoice, setStationChoice] = useState('')
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null)

  // Reset transient drawer state whenever the selection changes.
  useEffect(() => {
    setStationChoice('')
    setFeedback(null)
  }, [selId])

  if (!r) return null

  const spec = ROBOT_CLASS_SPECS[r.cls]
  const task = r.taskId ? sim.queue.get(r.taskId) : undefined
  const progress = taskProgress(r)
  const history = r.history.slice(-5).reverse()
  const openHelp = sim.openHelpFor(r.id)

  const runCommand = (fn: () => CommandResult, okText: string): void => {
    const res = fn()
    setFeedback(res.ok ? { ok: true, text: okText } : { ok: false, text: res.reason ?? 'Command refused' })
  }

  return (
    <section className="drawer" aria-label={`${r.id} details`}>
      <header className="drawer-head">
        <span className="rid rid-lg">{r.id}</span>
        <span className="rclass">{spec.label} class</span>
        <StateChip state={r.state} />
        <span className="drawer-pose">
          cell ({r.gx}, {r.gy}) · pos ({r.x.toFixed(2)}, {r.y.toFixed(2)})
        </span>
        <span className="spacer" />
        <button
          type="button"
          className="btn"
          onClick={() => fleetStore.selectRobot(null)}
          aria-label={`Close ${r.id} details`}
        >
          CLOSE
        </button>
      </header>

      <div className="drawer-body">
        <div className="drawer-col">
          <h3>STATUS</h3>
          <BatteryBar pct={r.battery} />
          <p className="drawer-note">
            {rosMode
              ? // Never quote sim spec numbers for a live robot: pose, motion
                // state, and battery are from the bridge; the class label is
                // whatever /fleet/status reported.
                `Pose & battery live via rosbridge · class ${spec.label} as reported by the bridge`
              : r.chargerName
                ? r.state === 'charging'
                  ? `Docked at ${r.chargerName}`
                  : `Assigned to ${r.chargerName}`
                : r.waitingForCharger
                  ? 'Low battery — waiting for a free charge bay'
                  : `Speed ${spec.speedCellsPerSec.toFixed(1)} cells/s · capacity ${spec.capacityKg} kg`}
          </p>
          {openHelp && (
            <p className="drawer-note drawer-note-warn">
              Open help request ({openHelp.kind.replace(/_/g, ' ')}) — resolve it in INTERVENTIONS
            </p>
          )}
        </div>

        <div className="drawer-col">
          <h3>CURRENT TASK</h3>
          {task ? (
            <>
              <p className="drawer-task">
                <span className="rid">{task.id}</span> {task.rackRow} → {task.stationName} · P{task.priority} ·{' '}
                {task.requiredClass}
              </p>
              {progress !== null && <ProgressBar fraction={progress} label={`Task progress for ${r.id}`} />}
            </>
          ) : (
            <p className="drawer-note">No active task</p>
          )}
          <h3>HISTORY · LAST 5</h3>
          {history.length === 0 ? (
            <p className="drawer-note">
              {rosMode ? 'No task feed in ROS mode (needs fleet-manager integration)' : 'No task outcomes yet this shift'}
            </p>
          ) : (
            <ul className="hist">
              {history.map((entry, i) => (
                <li key={`${entry.taskId}-${entry.tick}-${i}`} className="hist-row">
                  <span className="log-time">{formatSimClock(entry.tick)}</span>
                  <span className="rid">{entry.taskId}</span>
                  <span className={`hist-outcome hist-${entry.outcome}`}>{entry.outcome.toUpperCase()}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="drawer-col drawer-actions">
          <h3>ACTIONS</h3>
          {r.state === 'estopped' ? (
            <button
              type="button"
              className="btn btn-okline"
              disabled={sim.globalEstop}
              title={sim.globalEstop ? 'Release the global e-stop from the top bar first' : undefined}
              onClick={() => fleetStore.resumeRobot(r.id)}
            >
              RESUME {r.id}
            </button>
          ) : (
            <button type="button" className="btn btn-dangerline" onClick={() => fleetStore.estopRobot(r.id)}>
              E-STOP {r.id}
            </button>
          )}
          <button
            type="button"
            className="btn"
            onClick={() => runCommand(() => fleetStore.commandCharge(r.id), `${r.id} sent to charge`)}
          >
            SEND TO CHARGE
          </button>
          <div className="drawer-send">
            <label className="visually-hidden" htmlFor="station-pick">
              Destination station for {r.id}
            </label>
            <select
              id="station-pick"
              value={stationChoice}
              onChange={(e) => setStationChoice(e.target.value)}
            >
              <option value="">Send to station…</option>
              {COMMAND_STATIONS.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn"
              disabled={stationChoice === ''}
              onClick={() =>
                runCommand(
                  () => fleetStore.commandStation(r.id, stationChoice),
                  `${r.id} dispatched to ${stationChoice}`,
                )
              }
            >
              SEND
            </button>
          </div>
          <p className={`drawer-feedback ${feedback ? (feedback.ok ? 'fb-ok' : 'fb-err') : ''}`} role="status">
            {feedback?.text ?? ''}
          </p>
        </div>
      </div>
    </section>
  )
}
