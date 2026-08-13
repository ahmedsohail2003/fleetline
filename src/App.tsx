/**
 * Fleetline app shell — the operator console.
 *
 * CSS-grid control-room layout:
 *
 *   +----------------------------------------------------------+
 *   | top bar: identity · clock · KPIs · sim controls · e-stop |
 *   +--------+-----------------------------------+-------------+
 *   | fleet  |  live warehouse map               | interventions
 *   | roster |  (click-to-command, selection,    +-------------+
 *   |        |   detail drawer docked at bottom) | event log   |
 *   +--------+-----------------------------------+-------------+
 *   | command console (chat + voice, '/' to focus)             |
 *   +----------------------------------------------------------+
 *
 * All state flows through `fleetStore` (pub/sub over the deterministic sim);
 * components subscribe individually via useSyncExternalStore.
 */

import { useEffect, useSyncExternalStore } from 'react'
import { fleetStore } from './store'
import { demoController } from './demo/controller'
import DemoOverlay from './demo/DemoOverlay'
import TopBar from './ui/TopBar'
import Roster from './ui/Roster'
import MapView from './ui/MapView'
import Interventions from './ui/Interventions'
import EventLog from './ui/EventLog'
import DetailDrawer from './ui/DetailDrawer'
import CommandConsole from './ui/CommandConsole'

export default function App() {
  // Subscribed so the root data-source attribute (used by responsive CSS)
  // tracks the SIMULATION / ROS BRIDGE switch.
  useSyncExternalStore(fleetStore.subscribe, fleetStore.getSnapshot)

  // Esc anywhere clears the selection (and closes the detail drawer) —
  // except while typing in a text field, where Esc just leaves the field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return
      fleetStore.selectRobot(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // ?demo=1 auto-plays the guided demo shortly after load (reproducible
  // walkthroughs and scripted captures).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if (params.get('demo') !== '1') return
    const id = window.setTimeout(() => demoController.start(), 800)
    return () => window.clearTimeout(id)
  }, [])

  return (
    <div className="app" data-source={fleetStore.dataSource}>
      <TopBar />
      <aside className="panel panel-left" aria-label="Fleet roster">
        <Roster />
      </aside>
      <main className="center">
        <MapView />
        <DetailDrawer />
        <DemoOverlay />
      </main>
      <aside className="panel panel-right" aria-label="Interventions and event log">
        <Interventions />
        <EventLog />
      </aside>
      <CommandConsole />
    </div>
  )
}
