/**
 * ABOUT / RATIONALE panel — what this prototype is, the research question it
 * exists to answer, and what is honestly simulated versus real.
 *
 * Written in the first person: this is the designer-researcher's statement of
 * intent, not marketing copy. Keyboard contract: opens from the top-bar "?"
 * button, traps focus while open, Esc or the backdrop closes it, and focus
 * returns to wherever it was.
 */

import { useEffect, useRef } from 'react'

const FOCUSABLE = 'button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])'

export default function AboutPanel({ onClose }: { onClose: () => void }) {
  const panelRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null

    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        // Capture phase + stopPropagation so the app-level Esc handler
        // (deselect robot) doesn't also fire underneath the dialog.
        e.stopPropagation()
        onClose()
        return
      }
      if (e.key !== 'Tab') return
      const panel = panelRef.current
      if (!panel) return
      const focusables = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE))
      if (focusables.length === 0) return
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      const active = document.activeElement
      if (!panel.contains(active)) {
        e.preventDefault()
        first.focus()
      } else if (e.shiftKey && active === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && active === last) {
        e.preventDefault()
        first.focus()
      }
    }

    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      previouslyFocused?.focus()
    }
  }, [onClose])

  return (
    <div
      className="about-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        className="about"
        role="dialog"
        aria-modal="true"
        aria-label="About this prototype"
        ref={panelRef}
      >
        <header className="about-head">
          <h2>FLEETLINE — WHY THIS EXISTS</h2>
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose} autoFocus>
            CLOSE
          </button>
        </header>

        <div className="about-body">
          <section>
            <h3>What this is</h3>
            <p>
              I built Fleetline to work through a design problem I care about: what a single operator
              actually needs when they supervise a fleet of industrial autonomous mobile robots. Not
              joystick teleoperation — the robots plan their own paths, pick their own charge windows,
              and work a shared task queue. The operator's real job is exception handling, and this
              console is a testable proposal for how that job should feel: where the eyes rest, what
              interrupts, and how a command gets from intent to robot.
            </p>
          </section>

          <section>
            <h3>The research question</h3>
            <p className="about-rq">
              For a single operator supervising a multi-AMR fleet, does natural-language command
              (chat/voice) reduce time-to-intervention and workload versus direct manipulation for
              exception handling, without degrading situational awareness?
            </p>
          </section>

          <section>
            <h3>Three command modalities, one console</h3>
            <ul>
              <li>
                <b>Direct manipulation</b> — select a robot on the map or roster, click a station (or
                use the detail drawer). Precise and low-ambiguity, but it demands visual attention, a
                pointer, and one command per robot.
              </li>
              <li>
                <b>Chat</b> — type a sentence ("send AMR-2 to PACK-1", "pause robots in aisle 2").
                Eyes-free-er and batchable, but it adds interpretation latency and a trust question:
                did it understand me? Every response shows what was understood and a GRAMMAR/LLM
                provenance chip saying which engine parsed it.
              </li>
              <li>
                <b>Voice</b> — push-to-talk into the same pipeline. No wake word: intent to command
                stays a physical act, the same reason radios use PTT.
              </li>
            </ul>
            <p>
              All three exist in one console on purpose. They converge on the <i>same</i> command API,
              tagged with their modality, and the sim logs every command — accepted and refused — plus
              the decision latency on every intervention. A comparison study is only fair if the
              modalities compete against identical fleet behavior with identical capability; this
              console is that apparatus.
            </p>
          </section>

          <section>
            <h3>Interventions: the supervised-autonomy loop</h3>
            <p>
              When autonomy hits an exception it is not confident resolving alone — a blocked aisle, a
              stale localization estimate, a failed pick — the robot files a help request: a persistent
              card with the reason and a closed set of resolutions, each with its consequence spelled
              out. Requests never modal-interrupt and never auto-dismiss; the operator chooses the
              order. Resolving a request is the <i>only</i> way the robot's behavior changes. That
              contract — robots ask, operators decide, everything is logged — is the interaction
              pattern this prototype exists to refine and test.
            </p>
          </section>

          <section>
            <h3>What is simulated, what is real</h3>
            <ul>
              <li>
                <b>SIMULATION mode (default)</b> is exactly what the badge says: a deterministic,
                seeded warehouse simulation. No real robots, no field data. The same seed replays the
                same shift — which is a research feature, not just hygiene: every future participant
                can face the identical scenario.
              </li>
              <li>
                <b>ROS BRIDGE mode</b> speaks the real rosbridge v2 websocket protocol to a ROS 2
                graph: live poses, motion state, and battery in; goal and e-stop messages out. It has
                been tested against the bundled <i>mock</i> rosbridge server (labeled as a mock
                everywhere it appears) — not yet against physical robots. Everything the bridge cannot
                honestly claim (task KPIs, exception detection) goes dark in that mode with the reason
                stated.
              </li>
              <li>
                The <b>guided demo</b> is scripted narration over real behavior — every demo action
                goes through the same operator APIs the buttons use.
              </li>
            </ul>
          </section>

          <section>
            <h3>Evaluation status</h3>
            <p>
              <span className="about-status">[Evaluation designed; sessions pending]</span>{' '}
              <span className="about-dim">
                The instrumentation for the study is live in this build — per-command modality tags,
                refusals, and intervention decision latency all land in the command log and event
                log — and the session protocol is drafted in the companion research kit. No
                participant data has been collected; nothing on this screen is a study result.
              </span>
            </p>
          </section>
        </div>
      </div>
    </div>
  )
}
