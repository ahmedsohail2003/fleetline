/**
 * Guided-demo caption overlay: narration, step counter, a progress bar for
 * the full 60 s run, and the hand-over hint. Docked at the bottom of the map
 * so the eye stays near the fleet (and near the command console when the
 * auto-typed chat step runs).
 *
 * The overlay is presentation only — all demo behavior lives in the
 * controller, and any user interaction (Esc, any click or key) ends the tour.
 */

import { useSyncExternalStore } from 'react'
import { demoController } from './controller'

export default function DemoOverlay() {
  useSyncExternalStore(demoController.subscribe, demoController.getSnapshot)
  const d = demoController.state
  if (!d.running) return null

  return (
    <div className="demo-overlay" role="status" aria-live="polite">
      <div className="demo-head">
        <span className="demo-tag">GUIDED DEMO</span>
        <span className="demo-step">
          STEP {d.stepIndex + 1}/{d.stepCount}
        </span>
        <span className="spacer" />
        <span className="demo-hint">Esc or any click takes over</span>
        <button
          type="button"
          className="btn demo-stop"
          data-demo-toggle
          onClick={() => demoController.stop('canceled')}
        >
          STOP
        </button>
      </div>
      <p className="demo-caption">{d.caption}</p>
      <div className="demo-progress" aria-hidden="true">
        <div className="demo-progress-fill" style={{ animationDuration: `${d.totalMs}ms` }} />
      </div>
    </div>
  )
}
