/**
 * Map center: the live warehouse canvas plus its DOM interaction layer.
 *
 * Interaction model ('direct-manipulation' modality — see CommandSource in
 * sim/sim.ts; a later stage adds the 'chat' modality against the same
 * command API so the two can be compared in a study):
 *
 *   click robot            -> select (brand ring + detail drawer)
 *   click selected robot   -> deselect (toggle)
 *   click station, armed   -> command the selected robot there
 *   click empty floor      -> deselect
 *   hover robot            -> tooltip (id, state, battery, task)
 *
 * Every map-only affordance has a keyboard-reachable equivalent elsewhere:
 * selection via the roster buttons, dispatch via the drawer's station picker,
 * so the canvas itself can stay a pointer surface.
 */

import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import { fleetStore } from '../store'
import { computeLayout, drawFrame, robotAtPoint, stationAtPoint } from '../canvas'
import type { MapLayout } from '../canvas'
import { ROBOT_CLASS_SPECS } from '../sim/robot'
import { getStation } from '../sim/warehouse'
import { StateChip } from './bits'

/** Pixels reserved at the bottom of the map when the detail drawer is open. */
const DRAWER_INSET = 244
/** Lifetime of the command-issued flash ring, ms (wall clock: visual only). */
const FLASH_MS = 700

interface Toast {
  id: number
  kind: 'ok' | 'err'
  text: string
}

export default function MapView() {
  useSyncExternalStore(fleetStore.subscribe, fleetStore.getSnapshot)
  const sim = fleetStore.sim
  const selectedId = fleetStore.selectedRobotId
  const rosMode = fleetStore.dataSource === 'ros'
  const ros = fleetStore.ros

  const wrapRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const tooltipRef = useRef<HTMLDivElement | null>(null)
  const alphaRef = useRef(0)
  const layoutRef = useRef<MapLayout>({ cell: 10, ox: 0, oy: 0 })
  const hoverRef = useRef<{ robot: string | null; station: string | null }>({ robot: null, station: null })
  const flashesRef = useRef<Array<{ x: number; y: number; born: number }>>([])
  const toastSeq = useRef(0)

  const [hoverRobotId, setHoverRobotId] = useState<string | null>(null)
  const [toasts, setToasts] = useState<Toast[]>([])

  // The one requestAnimationFrame loop: advances the sim clock and repaints.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let raf = 0
    let last = performance.now()
    const loop = (now: number) => {
      const dt = Math.min(now - last, 250)
      last = now
      const alpha = fleetStore.advance(dt)
      alphaRef.current = alpha

      const cw = canvas.clientWidth
      const ch = canvas.clientHeight
      const dpr = window.devicePixelRatio || 1
      const bw = Math.round(cw * dpr)
      const bh = Math.round(ch * dpr)
      if (canvas.width !== bw || canvas.height !== bh) {
        canvas.width = bw
        canvas.height = bh
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

      const inset = fleetStore.selectedRobotId ? DRAWER_INSET : 0
      const L = computeLayout(cw, ch, inset)
      layoutRef.current = L

      const nowMs = performance.now()
      flashesRef.current = flashesRef.current.filter((f) => nowMs - f.born < FLASH_MS)
      drawFrame(ctx, fleetStore.sim, alpha, cw, ch, L, {
        selectedId: fleetStore.selectedRobotId,
        hoverId: hoverRef.current.robot,
        hoverStation: hoverRef.current.station,
        flashes: flashesRef.current.map((f) => ({ x: f.x, y: f.y, age: (nowMs - f.born) / FLASH_MS })),
      })
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [])

  const localPoint = (e: ReactMouseEvent): { px: number; py: number } => {
    const rect = canvasRef.current!.getBoundingClientRect()
    return { px: e.clientX - rect.left, py: e.clientY - rect.top }
  }

  const pushToast = (kind: Toast['kind'], text: string): void => {
    const id = ++toastSeq.current
    setToasts((t) => [...t.slice(-2), { id, kind, text }])
    window.setTimeout(() => {
      setToasts((t) => t.filter((x) => x.id !== id))
    }, 3800)
  }

  const handleMove = (e: ReactMouseEvent): void => {
    const wrap = wrapRef.current
    const canvas = canvasRef.current
    if (!wrap || !canvas) return
    const { px, py } = localPoint(e)
    const robot = robotAtPoint(fleetStore.sim, alphaRef.current, layoutRef.current, px, py)
    const station = !robot && fleetStore.selectedRobotId ? stationAtPoint(layoutRef.current, px, py) : null

    if (hoverRef.current.robot !== robot) setHoverRobotId(robot)
    hoverRef.current.robot = robot
    hoverRef.current.station = station
    wrap.style.cursor = robot ? 'pointer' : station ? 'crosshair' : 'default'

    const tip = tooltipRef.current
    if (tip) {
      const rect = canvas.getBoundingClientRect()
      const tx = Math.max(4, Math.min(px + 16, rect.width - 210))
      const ty = Math.max(4, Math.min(py + 16, rect.height - 96))
      tip.style.transform = `translate(${tx}px, ${ty}px)`
    }
  }

  const handleLeave = (): void => {
    hoverRef.current.robot = null
    hoverRef.current.station = null
    setHoverRobotId(null)
    if (wrapRef.current) wrapRef.current.style.cursor = 'default'
  }

  const handleClick = (e: ReactMouseEvent): void => {
    const { px, py } = localPoint(e)
    const robot = robotAtPoint(fleetStore.sim, alphaRef.current, layoutRef.current, px, py)
    if (robot) {
      fleetStore.selectRobot(fleetStore.selectedRobotId === robot ? null : robot)
      return
    }
    const sel = fleetStore.selectedRobotId
    if (sel) {
      const stationName = stationAtPoint(layoutRef.current, px, py)
      if (stationName) {
        // Direct manipulation: spatial click issues the command.
        const st = getStation(stationName)
        const res =
          st.kind === 'charger'
            ? fleetStore.commandCharge(sel, 'direct-manipulation', stationName)
            : fleetStore.commandStation(sel, stationName, 'direct-manipulation')
        if (res.ok) {
          flashesRef.current.push({ x: st.dock.x, y: st.dock.y, born: performance.now() })
          pushToast('ok', `${sel} → ${stationName}`)
        } else {
          pushToast('err', res.reason ?? 'Command refused')
        }
        return
      }
    }
    fleetStore.selectRobot(null)
  }

  const hoverRobot = hoverRobotId ? sim.robots.find((r) => r.id === hoverRobotId) : undefined
  const hoverTask = hoverRobot?.taskId ? sim.queue.get(hoverRobot.taskId) : undefined

  return (
    <div
      className="map-wrap"
      ref={wrapRef}
      onMouseMove={handleMove}
      onMouseLeave={handleLeave}
      onClick={handleClick}
    >
      <canvas
        ref={canvasRef}
        aria-label="Live warehouse map with robot positions. Use the fleet roster to select robots by keyboard; use the detail drawer to dispatch them."
      />

      {sim.globalEstop && (
        <div className="map-banner" role="alert">
          GLOBAL E-STOP ENGAGED — ALL ROBOTS HALTED · release from the top bar
        </div>
      )}

      {rosMode && ros && ros.status !== 'connected' && !sim.globalEstop && (
        <div className={`map-banner ${ros.status === 'connecting' ? 'map-banner-info' : 'map-banner-warn'}`} role="status">
          {ros.status === 'connecting'
            ? `ROS BRIDGE — connecting to ${ros.url} …`
            : `ROS BRIDGE — cannot reach ${ros.url} (retrying automatically) · switch DATA SOURCE to SIMULATION to keep working`}
        </div>
      )}

      {rosMode && ros?.status === 'connected' && sim.robots.length === 0 && (
        <div className="map-hint" role="status">
          Bridge connected — waiting for robots (<b>/fleet/status</b> + odometry)
        </div>
      )}

      {selectedId && !sim.globalEstop && (
        <div className="map-hint" role="status">
          <b>{selectedId}</b> selected — click a station to dispatch it · Esc to deselect
        </div>
      )}

      <div className="map-toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`}>
            {t.text}
          </div>
        ))}
      </div>

      <div
        ref={tooltipRef}
        className={`map-tip ${hoverRobot ? '' : 'map-tip-off'}`}
        aria-hidden="true"
      >
        {hoverRobot && (
          <>
            <div className="tip-head">
              <span className="rid">{hoverRobot.id}</span>
              <StateChip state={hoverRobot.state} />
            </div>
            <div className="tip-row">
              {ROBOT_CLASS_SPECS[hoverRobot.cls].label} class · battery {Math.round(hoverRobot.battery)}%
            </div>
            <div className="tip-row tip-dim">
              {hoverTask
                ? `${hoverTask.id} · ${hoverTask.rackRow} → ${hoverTask.stationName}`
                : hoverRobot.state === 'charging'
                  ? `Charging at ${hoverRobot.chargerName ?? 'bay'}`
                  : 'No active task'}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
