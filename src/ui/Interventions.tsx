/**
 * INTERVENTIONS (right panel, top): the supervised-autonomy queue.
 *
 * Every open help request renders as a persistent card with the robot id,
 * the reason, elapsed waiting time (pulsing amber — waiting robots cost
 * throughput), and the closed set of resolution actions from the sim. The
 * queue is deliberately not modal: help requests never steal focus or block
 * the rest of the console, and cards animate out on resolution.
 *
 * Decision latency (request opened -> operator choice) is recorded by the
 * sim and written to the event log with each resolution.
 */

import { useState, useSyncExternalStore } from 'react'
import { fleetStore } from '../store'
import { demoController } from '../demo/controller'
import type { HelpRequest } from '../sim/helpRequests'
import { formatElapsedTicks } from '../derive'

const LEAVE_MS = 260

function InterventionCard({
  h,
  leaving,
  highlighted,
  onResolve,
}: {
  h: HelpRequest
  leaving: boolean
  /** Guided demo: draw the operator's eye to the card being narrated. */
  highlighted: boolean
  onResolve: (h: HelpRequest, optionId: string) => void
}) {
  const sim = fleetStore.sim
  const waitedTicks = (h.resolvedTick ?? sim.tick) - h.createdTick
  return (
    <article
      className={`iv ${leaving ? 'iv-leaving' : ''} ${highlighted ? 'iv-demo-target' : ''}`}
      aria-label={`Help request from ${h.robotId}`}
    >
      <header className="iv-head">
        <button
          type="button"
          className="iv-robot rid"
          onClick={() => fleetStore.selectRobot(h.robotId)}
          title={`Select ${h.robotId} on the map`}
        >
          {h.robotId}
        </button>
        <span className="iv-kind">{h.kind.replace(/_/g, ' ')}</span>
        {leaving ? (
          <span className="iv-wait iv-done">RESOLVED</span>
        ) : (
          <span className="iv-wait pulse">WAITING {formatElapsedTicks(waitedTicks)}</span>
        )}
      </header>
      <p className="iv-reason">{h.reason}</p>
      <div className="iv-opts">
        {h.options.map((o) => (
          <button
            key={o.id}
            type="button"
            className="iv-opt"
            disabled={leaving}
            onClick={() => onResolve(h, o.id)}
          >
            <span className="iv-opt-label">{o.label}</span>
            <span className="iv-opt-detail">{o.detail}</span>
          </button>
        ))}
      </div>
    </article>
  )
}

export default function Interventions() {
  useSyncExternalStore(fleetStore.subscribe, fleetStore.getSnapshot)
  useSyncExternalStore(demoController.subscribe, demoController.getSnapshot)
  const sim = fleetStore.sim
  const rosMode = fleetStore.dataSource === 'ros'
  const highlightId = demoController.state.highlightHelpId
  const open = sim.openHelpRequests()
  // Resolved cards linger briefly with a leave animation before unmounting.
  const [leaving, setLeaving] = useState<HelpRequest[]>([])

  const resolve = (h: HelpRequest, optionId: string): void => {
    setLeaving((ls) => (ls.some((x) => x.id === h.id) ? ls : [...ls, h]))
    fleetStore.resolveHelp(h.id, optionId)
    window.setTimeout(() => {
      setLeaving((ls) => ls.filter((x) => x.id !== h.id))
    }, LEAVE_MS)
  }

  // Merge open + leaving, keeping stable creation order so cards don't jump.
  const cards: Array<{ h: HelpRequest; leaving: boolean }> = [
    ...open.map((h) => ({ h, leaving: false })),
    ...leaving.filter((h) => !open.some((o) => o.id === h.id)).map((h) => ({ h, leaving: true })),
  ].sort((a, b) => a.h.createdTick - b.h.createdTick || (a.h.id < b.h.id ? -1 : 1))

  return (
    <section className="interventions" aria-label="Interventions">
      <header className="panel-head">
        <h2>INTERVENTIONS</h2>
        <span className="panel-sub" aria-live="polite">
          {open.length > 0 ? <span className="iv-count">{open.length} waiting</span> : 'supervised autonomy'}
        </span>
      </header>
      <div className="iv-list">
        {rosMode ? (
          // Honesty over reassurance: in ROS mode the console has no
          // exception feed, so it must not claim the fleet is fine.
          <div className="iv-empty iv-unavailable">
            Exception detection requires fleet-manager integration — simulated in SIMULATION mode.
          </div>
        ) : cards.length === 0 ? (
          <div className="iv-empty">
            <span className="iv-empty-dot" aria-hidden="true" />
            No robots need help — fleet is autonomous
          </div>
        ) : (
          cards.map(({ h, leaving: isLeaving }) => (
            <InterventionCard
              key={h.id}
              h={h}
              leaving={isLeaving}
              highlighted={h.id === highlightId}
              onResolve={resolve}
            />
          ))
        )}
      </div>
    </section>
  )
}
