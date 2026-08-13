/**
 * Top bar: identity + clock, DATA SOURCE switch, fleet KPIs, sim controls,
 * global e-stop.
 *
 * DATA SOURCE is the stage-4 seam: SIMULATION runs the built-in deterministic
 * engine; ROS BRIDGE connects to a rosbridge websocket and takes poses/battery
 * live from ROS topics. The switch is honest in both directions — SIMULATION
 * is badged as such, and ROS mode disables (with reasons) everything that
 * would need fleet-manager data the console doesn't have.
 *
 * The e-stop is deliberately asymmetric: engaging is one click (safety
 * actions must be instant), releasing requires an explicit confirm step
 * (resuming a halted fleet is the consequential action). In ROS mode the same
 * control publishes std_msgs/Bool to every robot's /emergency_stop topic.
 */

import { useEffect, useState, useSyncExternalStore } from 'react'
import { fleetStore } from '../store'
import type { SimSpeed } from '../store'
import { formatSimClock } from '../sim/events'
import { formatDurationS } from '../derive'
import { demoController } from '../demo/controller'
import AboutPanel from './AboutPanel'

const SPEEDS: SimSpeed[] = [1, 2, 4]

const NO_KPI_TITLE = 'Task KPIs come from the simulation engine — over the ROS bridge they would need fleet-manager integration'
const NO_INTERV_TITLE = 'Exception detection requires fleet-manager integration — simulated in SIMULATION mode'

function Kpi({ label, value, tone, title }: { label: string; value: string; tone?: 'warn'; title?: string }) {
  return (
    <div className={`kpi ${tone === 'warn' ? 'kpi-warn' : ''}`} title={title}>
      <span className="kpi-value">{value}</span>
      <span className="kpi-label">{label}</span>
    </div>
  )
}

function ConnectionChip() {
  const ros = fleetStore.ros
  if (!ros) return null
  const status = ros.status
  const cls = status === 'connected' ? 'chip-executing' : status === 'connecting' ? 'chip-moving' : 'chip-estop'
  const label = status === 'connected' ? 'CONNECTED' : status === 'connecting' ? 'CONNECTING…' : 'ERROR'
  const title =
    status === 'connected'
      ? `Live data from ${ros.url} (rosbridge v2 JSON protocol)`
      : status === 'connecting'
        ? `Opening websocket to ${ros.url}`
        : `${ros.lastError ?? 'connection failed'} — retrying automatically; the console keeps working, switch DATA SOURCE to SIMULATION for the built-in engine`
  return (
    <span className={`chip ${cls}`} title={title} role="status" aria-label={`ROS bridge ${label}`}>
      <span className="chip-dot" aria-hidden="true" />
      {label}
    </span>
  )
}

function BridgePopover({ onClose }: { onClose: () => void }) {
  const [url, setUrl] = useState(fleetStore.rosUrl)
  const apply = (): void => {
    fleetStore.reconnectRos(url.trim() === '' ? undefined : url.trim())
    onClose()
  }
  return (
    <div className="tb-pop" role="dialog" aria-label="ROS bridge settings">
      <div className="set-head">
        <h3>ROS BRIDGE</h3>
        <span className="spacer" />
        <button type="button" className="btn" onClick={onClose}>
          CLOSE
        </button>
      </div>
      <div className="set-field">
        <label htmlFor="bridge-url">ROSBRIDGE WEBSOCKET URL</label>
        <input
          id="bridge-url"
          type="text"
          value={url}
          autoComplete="off"
          spellCheck={false}
          placeholder="ws://localhost:9090"
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') apply()
          }}
        />
      </div>
      <p className="set-note">
        Fleetline speaks the rosbridge v2 JSON protocol — point it at a{' '}
        <span className="cm-mono">rosbridge_server</span> websocket. Robot poses, motion state, and battery are
        live from <span className="cm-mono">/&lt;ns&gt;/odom</span> and{' '}
        <span className="cm-mono">/&lt;ns&gt;/battery_state</span>; commands publish{' '}
        <span className="cm-mono">goal_pose</span> and <span className="cm-mono">emergency_stop</span>. Task and
        exception data need fleet-manager integration and stay disabled in this mode. Setup: docs/ROS2.md.
      </p>
      <div className="set-actions">
        <button type="button" className="btn btn-okline" onClick={apply}>
          APPLY &amp; CONNECT
        </button>
      </div>
    </div>
  )
}

function DataSourceControl() {
  const rosMode = fleetStore.dataSource === 'ros'
  const [cfgOpen, setCfgOpen] = useState(false)

  // Close the settings popover when leaving ROS mode.
  useEffect(() => {
    if (!rosMode) setCfgOpen(false)
  }, [rosMode])

  return (
    <div className="tb-source" role="group" aria-label="Data source">
      <div className="seg">
        <button
          type="button"
          className={`seg-btn ${rosMode ? '' : 'seg-on'}`}
          aria-pressed={!rosMode}
          title="Built-in deterministic simulation engine (full task + exception behavior, no real robots)"
          onClick={() => fleetStore.setDataSource('simulation')}
        >
          SIMULATION
        </button>
        <button
          type="button"
          className={`seg-btn ${rosMode ? 'seg-on' : ''}`}
          aria-pressed={rosMode}
          title={`Live robot data over a rosbridge websocket (${fleetStore.rosUrl})`}
          onClick={() => fleetStore.setDataSource('ros')}
        >
          ROS BRIDGE
        </button>
      </div>
      {rosMode ? (
        <>
          <ConnectionChip />
          {fleetStore.ros?.status === 'error' && (
            <button type="button" className="btn" onClick={() => fleetStore.reconnectRos()}>
              RETRY
            </button>
          )}
          <button type="button" className="btn" aria-expanded={cfgOpen} onClick={() => setCfgOpen((v) => !v)}>
            BRIDGE…
          </button>
          {cfgOpen && <BridgePopover onClose={() => setCfgOpen(false)} />}
        </>
      ) : (
        <span
          className="badge"
          title="All data on this screen is generated by a deterministic simulation — there is no real robot fleet behind it"
        >
          SIMULATION
        </span>
      )}
    </div>
  )
}

function EstopControl() {
  const engaged = fleetStore.sim.globalEstop
  const [arming, setArming] = useState(false)

  // Disarm the confirm step whenever the e-stop state changes underneath it,
  // and time it out after 6 s so a stale confirm can't linger.
  useEffect(() => {
    setArming(false)
  }, [engaged])
  useEffect(() => {
    if (!arming) return
    const t = window.setTimeout(() => setArming(false), 6000)
    return () => window.clearTimeout(t)
  }, [arming])

  if (!engaged) {
    return (
      <button
        type="button"
        className="estop-btn"
        onClick={() => fleetStore.estopAll()}
        aria-label="Global emergency stop — halt all robots immediately"
      >
        E-STOP
      </button>
    )
  }
  if (!arming) {
    return (
      <div className="estop-group" role="group" aria-label="Global e-stop engaged">
        <span className="estop-flag">E-STOP ACTIVE</span>
        <button type="button" className="btn btn-warnline" onClick={() => setArming(true)}>
          RELEASE E-STOP…
        </button>
      </div>
    )
  }
  return (
    <div className="estop-group estop-confirm" role="group" aria-label="Confirm e-stop release">
      <span className="estop-confirm-q">Resume all robots?</span>
      <button
        type="button"
        className="btn btn-okline"
        onClick={() => {
          fleetStore.resumeAll()
          setArming(false)
        }}
      >
        CONFIRM RELEASE
      </button>
      <button type="button" className="btn" onClick={() => setArming(false)}>
        CANCEL
      </button>
    </div>
  )
}

export default function TopBar() {
  useSyncExternalStore(fleetStore.subscribe, fleetStore.getSnapshot)
  useSyncExternalStore(demoController.subscribe, demoController.getSnapshot)
  const sim = fleetStore.sim
  const rosMode = fleetStore.dataSource === 'ros'
  const kpis = sim.kpis()
  const openHelp = sim.openHelpRequests().length
  const paused = fleetStore.paused
  const demoRunning = demoController.state.running
  const [aboutOpen, setAboutOpen] = useState(false)

  return (
    <header className="topbar">
      <div className="tb-brand">
        <span className="wordmark">FLEETLINE</span>
        <DataSourceControl />
        <span
          className="clock"
          aria-label={rosMode ? `Wall clock ${formatSimClock(sim.tick)}` : `Simulation clock ${formatSimClock(sim.tick)}`}
          title={rosMode ? 'Local wall clock (live data mode)' : 'Simulation shift clock'}
        >
          {formatSimClock(sim.tick)}
        </span>
      </div>

      <div className="tb-kpis" role="group" aria-label="Fleet KPIs">
        <Kpi
          label="TASKS DONE"
          value={rosMode ? '—' : String(kpis.tasksCompleted)}
          title={rosMode ? NO_KPI_TITLE : undefined}
        />
        <Kpi
          label="AVG TASK"
          value={rosMode ? '—' : kpis.tasksCompleted > 0 ? formatDurationS(kpis.avgTaskTimeS) : '—'}
          title={rosMode ? NO_KPI_TITLE : undefined}
        />
        <Kpi
          label="UTILIZATION"
          value={rosMode ? '—' : `${kpis.utilizationPct.toFixed(0)}%`}
          title={rosMode ? NO_KPI_TITLE : undefined}
        />
        <Kpi
          label="OPEN INTERV"
          value={rosMode ? '—' : String(openHelp)}
          tone={!rosMode && openHelp > 0 ? 'warn' : undefined}
          title={rosMode ? NO_INTERV_TITLE : undefined}
        />
      </div>

      <div className="tb-controls" role="group" aria-label="Simulation controls">
        <button
          type="button"
          className="btn"
          aria-pressed={paused}
          disabled={rosMode}
          title={rosMode ? 'Live data cannot be paused — this controls the simulation clock only' : undefined}
          onClick={() => fleetStore.setPaused(!paused)}
        >
          {paused ? 'RESUME' : 'PAUSE'}
        </button>
        <div className="seg" role="group" aria-label="Simulation speed">
          {SPEEDS.map((s) => (
            <button
              key={s}
              type="button"
              className={`seg-btn ${!rosMode && fleetStore.speed === s ? 'seg-on' : ''}`}
              aria-pressed={!rosMode && fleetStore.speed === s}
              disabled={rosMode}
              title={rosMode ? 'Live data runs at real time — speed applies to the simulation clock only' : undefined}
              onClick={() => fleetStore.setSpeed(s)}
            >
              {s}x
            </button>
          ))}
        </div>
        <button
          type="button"
          className="btn btn-toggle"
          aria-pressed={!rosMode && sim.autoGenerate}
          disabled={rosMode}
          title={
            rosMode
              ? 'Task auto-generation is a simulation feature — over the ROS bridge, tasks would come from a fleet manager (not integrated)'
              : 'Toggle the simulated order stream that feeds the task queue'
          }
          onClick={() => fleetStore.setAutoGenerate(!sim.autoGenerate)}
        >
          AUTO TASKS <b>{rosMode ? 'N/A' : sim.autoGenerate ? 'ON' : 'OFF'}</b>
        </button>
      </div>

      <div className="tb-meta" role="group" aria-label="Demo and about">
        <button
          type="button"
          className={`btn demo-btn ${demoRunning ? 'demo-btn-live' : ''}`}
          data-demo-toggle
          aria-pressed={demoRunning}
          title={
            demoRunning
              ? 'Stop the guided demo and take over'
              : 'A 60-second scripted tour: tasks, an intervention, a chat command, and the e-stop — Esc or any interaction hands over control'
          }
          onClick={() => demoController.toggle()}
        >
          {demoRunning ? (
            '■ STOP DEMO'
          ) : (
            <>
              ▶ DEMO<span className="demo-len"> · 60 s</span>
            </>
          )}
        </button>
        <button
          type="button"
          className="btn about-btn"
          aria-label="About this prototype — what it is, the research question, and what is simulated"
          aria-expanded={aboutOpen}
          title="About this prototype — what it is, the research question, and what is simulated"
          onClick={() => setAboutOpen(true)}
        >
          ?
        </button>
      </div>

      <EstopControl />

      {aboutOpen && <AboutPanel onClose={() => setAboutOpen(false)} />}
    </header>
  )
}
