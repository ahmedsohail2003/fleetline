/**
 * Guided-demo runner: schedules the script steps on the wall clock, applies
 * each step's action through the store's operator APIs, and exposes a small
 * pub/sub state for the caption overlay, the top-bar button, and the
 * interventions-card highlight.
 *
 * Hand-over rule: the demo is a tour, not a lock. Esc or ANY real user
 * interaction (pointer down / key down anywhere) cancels it immediately and
 * leaves the console exactly as the story left it — the operator takes over
 * mid-scene, which is the point.
 */

import { fleetStore } from '../store'
import type { DemoRunContext } from './script'
import { applyDemoAction, chatSentence, DEMO_STEPS, DEMO_TOTAL_MS, stepStartMs } from './script'

/** CustomEvent the console listens for: `detail.text` is typed keystroke by
 * keystroke through the real command pipeline, then submitted. */
export const DEMO_CHAT_EVENT = 'fleetline:demo-chat'
/** Fired when the demo stops so an in-progress auto-type halts un-submitted. */
export const DEMO_CHAT_CANCEL_EVENT = 'fleetline:demo-chat-cancel'

export interface DemoUiState {
  running: boolean
  /** 0-based index of the current step while running. */
  stepIndex: number
  stepCount: number
  caption: string
  totalMs: number
  /** Help request the demo just fired (interventions card highlight). */
  highlightHelpId: string | null
}

const IDLE_STATE: DemoUiState = {
  running: false,
  stepIndex: 0,
  stepCount: DEMO_STEPS.length,
  caption: '',
  totalMs: DEMO_TOTAL_MS,
  highlightHelpId: null,
}

class DemoController {
  state: DemoUiState = IDLE_STATE

  private listeners = new Set<() => void>()
  private timers: number[] = []
  private ctx: DemoRunContext = { helpId: null }
  private version = 0

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  getSnapshot = (): number => this.version

  start(): void {
    if (this.state.running) return
    // The story needs the deterministic engine at real time.
    if (fleetStore.dataSource !== 'simulation') fleetStore.setDataSource('simulation')
    if (fleetStore.sim.globalEstop) fleetStore.resumeAll()
    fleetStore.setPaused(false)
    fleetStore.setSpeed(1)
    fleetStore.selectRobot(null)
    fleetStore.sim.events.append(
      fleetStore.sim.tick,
      'SIM',
      'GUIDED DEMO started — scripted actions on the live simulation',
    )

    this.ctx = { helpId: null }
    this.state = { ...IDLE_STATE, running: true, caption: DEMO_STEPS[0].caption }
    this.notify()

    DEMO_STEPS.forEach((step, i) => {
      this.timers.push(
        window.setTimeout(() => {
          if (!this.state.running) return
          this.state = { ...this.state, stepIndex: i, caption: step.caption }
          if (step.action === 'chat') {
            window.dispatchEvent(
              new CustomEvent(DEMO_CHAT_EVENT, { detail: { text: chatSentence(fleetStore.sim) } }),
            )
          } else if (step.action === 'inject-help') {
            applyDemoAction(fleetStore, step.action, this.ctx)
            this.state = { ...this.state, highlightHelpId: this.ctx.helpId }
          } else if (step.action === 'resolve-help') {
            applyDemoAction(fleetStore, step.action, this.ctx)
            this.state = { ...this.state, highlightHelpId: null }
          } else if (step.action) {
            applyDemoAction(fleetStore, step.action, this.ctx)
          }
          this.notify()
        }, stepStartMs(i)),
      )
    })
    this.timers.push(
      window.setTimeout(() => {
        this.stop('finished')
      }, DEMO_TOTAL_MS),
    )

    // Any real interaction hands control back to the operator. Capture phase
    // so the demo ends before the interaction itself takes effect; the
    // interaction still does whatever it normally does.
    window.addEventListener('pointerdown', this.onUserInteraction, true)
    window.addEventListener('keydown', this.onUserInteraction, true)
  }

  stop(reason: 'finished' | 'canceled'): void {
    if (!this.state.running) return
    for (const id of this.timers) window.clearTimeout(id)
    this.timers = []
    window.removeEventListener('pointerdown', this.onUserInteraction, true)
    window.removeEventListener('keydown', this.onUserInteraction, true)
    window.dispatchEvent(new CustomEvent(DEMO_CHAT_CANCEL_EVENT))
    this.state = { ...IDLE_STATE }
    fleetStore.sim.events.append(
      fleetStore.sim.tick,
      'SIM',
      reason === 'finished'
        ? 'GUIDED DEMO finished — the console is yours'
        : 'GUIDED DEMO canceled — you have control',
    )
    this.notify()
  }

  toggle(): void {
    if (this.state.running) this.stop('canceled')
    else this.start()
  }

  private onUserInteraction = (e: Event): void => {
    if ((e as KeyboardEvent).key === 'Escape') {
      this.stop('canceled')
      return
    }
    // The demo/stop buttons toggle via their own click handler — if the
    // pointerdown also canceled here, the click would immediately restart.
    const t = e.target as HTMLElement | null
    if (t && typeof t.closest === 'function' && t.closest('[data-demo-toggle]')) return
    this.stop('canceled')
  }

  private notify(): void {
    this.version++
    for (const fn of this.listeners) fn()
  }
}

export const demoController = new DemoController()
