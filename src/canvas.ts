/**
 * Canvas renderer for the Fleetline warehouse view.
 *
 * Pure drawing + pure hit-testing — reads the sim, never mutates it. Robot
 * positions are interpolated between the previous and current tick by `alpha`
 * for smooth 60 fps motion on top of the 10 Hz sim.
 *
 * The map is one arm of the click-to-command loop (the 'direct-manipulation'
 * modality — see CommandSource in sim/sim.ts): MapView hit-tests clicks with
 * robotAtPoint/stationAtPoint and the renderer echoes the interaction state
 * back (selection ring, planned path, station hover, command flash).
 */

import type { FleetSim } from './sim/sim'
import type { Robot, RobotState } from './sim/robot'
import { ROBOT_CLASS_SPECS } from './sim/robot'
import { AISLES, GRID_H, GRID_W, RACK_ROWS, STATIONS } from './sim/warehouse'

// Design tokens (industrial control-room, dark)
const C = {
  bg: '#0B0E14',
  floor: '#0D1119',
  surface: '#141926',
  surface2: '#1C2333',
  border: '#2A3347',
  text: '#E6EAF2',
  textDim: '#8A94A8',
  ok: '#34D399',
  warn: '#F59E0B',
  danger: '#EF4444',
  info: '#60A5FA',
  brand: '#7DD3FC',
  charging: '#A78BFA',
} as const

export const STATE_COLORS: Record<RobotState, string> = {
  idle: '#8A94A8',
  moving: '#60A5FA',
  executing: '#34D399',
  blocked: '#F59E0B',
  awaiting_help: '#F59E0B',
  estopped: '#EF4444',
  charging: '#A78BFA',
}

const STATE_LABELS: Record<RobotState, string> = {
  idle: 'IDLE',
  moving: 'MOVING',
  executing: 'EXECUTING',
  blocked: 'BLOCKED',
  awaiting_help: 'NEEDS HELP',
  estopped: 'E-STOP',
  charging: 'CHARGING',
}

const MONO = "'JetBrains Mono', ui-monospace, monospace"

export interface MapLayout {
  cell: number
  ox: number
  oy: number
}

/** Expanding ring drawn where a command was just issued. age in [0, 1). */
export interface CommandFlash {
  x: number
  y: number
  age: number
}

/** Interaction state the DOM layer feeds into the renderer each frame. */
export interface MapUiState {
  selectedId: string | null
  hoverId: string | null
  /** Station under the cursor while a robot is selected (command target). */
  hoverStation: string | null
  flashes: CommandFlash[]
}

export const EMPTY_UI: MapUiState = { selectedId: null, hoverId: null, hoverStation: null, flashes: [] }

/**
 * Fit the grid into a w x h box. `insetBottom` reserves pixels at the bottom
 * (e.g. for the robot detail drawer) so the map rescales instead of hiding
 * robots behind the overlay.
 */
export function computeLayout(w: number, h: number, insetBottom = 0): MapLayout {
  const pad = 24
  const usableH = Math.max(80, h - insetBottom)
  const cell = Math.min((w - pad * 2) / GRID_W, (usableH - pad * 2) / GRID_H)
  const ox = (w - cell * GRID_W) / 2
  const oy = (usableH - cell * GRID_H) / 2
  return { cell, ox, oy }
}

// ---------------------------------------------------------------------------
// Hit testing (pure geometry, unit-tested)
// ---------------------------------------------------------------------------

function interpXY(r: Robot, alpha: number): { x: number; y: number } {
  return { x: r.prevX + (r.x - r.prevX) * alpha, y: r.prevY + (r.y - r.prevY) * alpha }
}

/** Robot id under the point (px, py) in canvas CSS pixels, or null. */
export function robotAtPoint(sim: FleetSim, alpha: number, L: MapLayout, px: number, py: number): string | null {
  let bestId: string | null = null
  let bestDist = Infinity
  for (const r of sim.robots) {
    const p = interpXY(r, alpha)
    const cx = L.ox + (p.x + 0.5) * L.cell
    const cy = L.oy + (p.y + 0.5) * L.cell
    // Generous hit radius so small robots stay clickable at small cell sizes.
    const radius = Math.max((ROBOT_CLASS_SPECS[r.cls].footprint * L.cell) / 2 + 3, L.cell * 0.55)
    const d = Math.hypot(px - cx, py - cy)
    if (d <= radius && d < bestDist) {
      bestId = r.id
      bestDist = d
    }
  }
  return bestId
}

/** Station name whose footprint contains (px, py), or null. */
export function stationAtPoint(L: MapLayout, px: number, py: number): string | null {
  for (const st of STATIONS) {
    const xs = st.cells.map((c) => c.x)
    const ys = st.cells.map((c) => c.y)
    const x0 = L.ox + Math.min(...xs) * L.cell - 2
    const y0 = L.oy + Math.min(...ys) * L.cell - 2
    const x1 = L.ox + (Math.max(...xs) + 1) * L.cell + 2
    const y1 = L.oy + (Math.max(...ys) + 1) * L.cell + 2
    if (px >= x0 && px <= x1 && py >= y0 && py <= y1) return st.name
  }
  return null
}

// ---------------------------------------------------------------------------
// Frame
// ---------------------------------------------------------------------------

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

export function drawFrame(
  ctx: CanvasRenderingContext2D,
  sim: FleetSim,
  alpha: number,
  w: number,
  h: number,
  L: MapLayout,
  ui: MapUiState = EMPTY_UI,
): void {
  ctx.fillStyle = C.bg
  ctx.fillRect(0, 0, w, h)

  drawFloor(ctx, L)
  drawRacks(ctx, L)
  drawAisleLabels(ctx, L)
  drawStations(ctx, L, ui)
  drawObstacles(ctx, sim, L)
  const selected = ui.selectedId ? sim.robots.find((r) => r.id === ui.selectedId) : undefined
  if (selected) drawPlannedPath(ctx, selected, alpha, L)
  for (const r of sim.robots) {
    drawRobot(ctx, r, alpha, L, r.id === ui.selectedId, r.id === ui.hoverId)
  }
  for (const f of ui.flashes) drawFlash(ctx, f, L)
}

function drawFloor(ctx: CanvasRenderingContext2D, L: MapLayout): void {
  const { cell, ox, oy } = L
  // Interior floor
  ctx.fillStyle = C.floor
  ctx.fillRect(ox + cell, oy + cell, cell * (GRID_W - 2), cell * (GRID_H - 2))
  // Grid lines
  ctx.strokeStyle = 'rgba(42, 51, 71, 0.35)'
  ctx.lineWidth = 1
  ctx.beginPath()
  for (let x = 1; x < GRID_W; x++) {
    ctx.moveTo(ox + x * cell, oy + cell)
    ctx.lineTo(ox + x * cell, oy + (GRID_H - 1) * cell)
  }
  for (let y = 1; y < GRID_H; y++) {
    ctx.moveTo(ox + cell, oy + y * cell)
    ctx.lineTo(ox + (GRID_W - 1) * cell, oy + y * cell)
  }
  ctx.stroke()
  // Perimeter wall
  ctx.strokeStyle = C.border
  ctx.lineWidth = 2
  roundRect(ctx, ox + cell * 0.5, oy + cell * 0.5, cell * (GRID_W - 1), cell * (GRID_H - 1), 6)
  ctx.stroke()
}

function drawRacks(ctx: CanvasRenderingContext2D, L: MapLayout): void {
  const { cell, ox, oy } = L
  for (const row of RACK_ROWS) {
    for (const seg of row.segments) {
      const x = ox + seg.x0 * cell
      const y = oy + seg.y * cell + cell * 0.08
      const wpx = (seg.x1 - seg.x0 + 1) * cell
      const hpx = cell * 0.84
      ctx.fillStyle = C.surface2
      ctx.strokeStyle = C.border
      ctx.lineWidth = 1
      roundRect(ctx, x, y, wpx, hpx, 3)
      ctx.fill()
      ctx.stroke()
      // Slot ticks
      ctx.strokeStyle = 'rgba(42, 51, 71, 0.8)'
      ctx.beginPath()
      for (let sx = seg.x0 + 1; sx <= seg.x1; sx++) {
        ctx.moveTo(ox + sx * cell, y + 2)
        ctx.lineTo(ox + sx * cell, y + hpx - 2)
      }
      ctx.stroke()
    }
    // Rack row label at the left end of the first segment
    ctx.fillStyle = C.textDim
    ctx.font = `${Math.max(8, cell * 0.42)}px ${MONO}`
    ctx.textAlign = 'right'
    ctx.textBaseline = 'middle'
    ctx.fillText(row.name, ox + (row.segments[0].x0 - 0.4) * cell, oy + (row.y + 0.5) * cell)
  }
}

function drawAisleLabels(ctx: CanvasRenderingContext2D, L: MapLayout): void {
  const { cell, ox, oy } = L
  ctx.fillStyle = 'rgba(138, 148, 168, 0.55)'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.font = `${Math.max(8, cell * 0.4)}px ${MONO}`
  for (const a of AISLES) {
    const cy = oy + ((a.y0 + a.y1 + 1) / 2) * cell
    ctx.fillText(a.name, ox + ((a.x0 + a.x1 + 1) / 2) * cell, cy)
  }
}

function drawStations(ctx: CanvasRenderingContext2D, L: MapLayout, ui: MapUiState): void {
  const { cell, ox, oy } = L
  for (const st of STATIONS) {
    const xs = st.cells.map((c) => c.x)
    const ys = st.cells.map((c) => c.y)
    const x0 = Math.min(...xs)
    const y0 = Math.min(...ys)
    const x1 = Math.max(...xs)
    const y1 = Math.max(...ys)
    const px = ox + x0 * cell + 1
    const py = oy + y0 * cell + 1
    const pw = (x1 - x0 + 1) * cell - 2
    const ph = (y1 - y0 + 1) * cell - 2

    let color: string = C.info
    if (st.kind === 'charger') color = C.charging
    if (st.kind === 'staging') color = C.textDim

    // Command-target affordance: while a robot is selected, the hovered
    // station brightens (the cursor also switches to crosshair in MapView).
    const isTarget = ui.selectedId !== null && ui.hoverStation === st.name

    ctx.save()
    ctx.fillStyle = isTarget ? C.brand : color
    ctx.globalAlpha = isTarget ? 0.16 : 0.08
    roundRect(ctx, px, py, pw, ph, 4)
    ctx.fill()
    ctx.globalAlpha = isTarget ? 1 : 0.55
    ctx.strokeStyle = isTarget ? C.brand : color
    ctx.lineWidth = isTarget ? 1.5 : 1
    if (st.kind === 'staging' && !isTarget) ctx.setLineDash([4, 3])
    roundRect(ctx, px, py, pw, ph, 4)
    ctx.stroke()
    ctx.restore()

    // Label
    ctx.fillStyle = isTarget ? C.brand : color
    ctx.font = `${Math.max(8, cell * 0.38)}px ${MONO}`
    ctx.textAlign = 'center'
    if (st.kind === 'charger') {
      ctx.textBaseline = 'top'
      // Neighboring bay labels collide when the map is small (e.g. with the
      // detail drawer open at 1280 wide) — shorten CHARGE-n to C-n there.
      const label = ctx.measureText(st.name).width > (pw + cell) * 1.9 ? st.name.replace('CHARGE-', 'C') : st.name
      ctx.fillText(label, px + pw / 2, py + ph + 3)
    } else if (ph > pw * 1.4) {
      // Tall narrow boxes (e.g. RECEIVING): rotate the label to fit.
      ctx.save()
      ctx.translate(px + pw / 2, py + ph / 2)
      ctx.rotate(-Math.PI / 2)
      ctx.textBaseline = 'middle'
      ctx.fillText(st.name, 0, 0)
      ctx.restore()
    } else {
      ctx.textBaseline = 'middle'
      ctx.fillText(st.name, px + pw / 2, py + ph / 2)
    }
  }
}

function drawObstacles(ctx: CanvasRenderingContext2D, sim: FleetSim, L: MapLayout): void {
  const { cell, ox, oy } = L
  for (const obs of sim.obstacles.values()) {
    const px = ox + obs.x * cell + 2
    const py = oy + obs.y * cell + 2
    const s = cell - 4
    ctx.save()
    ctx.fillStyle = 'rgba(245, 158, 11, 0.16)'
    ctx.strokeStyle = C.warn
    ctx.lineWidth = 1.5
    roundRect(ctx, px, py, s, s, 3)
    ctx.fill()
    ctx.stroke()
    // Hatch
    ctx.beginPath()
    ctx.moveTo(px + 2, py + s - 2)
    ctx.lineTo(px + s - 2, py + 2)
    ctx.stroke()
    ctx.restore()
    ctx.fillStyle = C.warn
    ctx.font = `bold ${Math.max(9, cell * 0.5)}px ${MONO}`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText('!', px + s / 2, py + s / 2 + 1)
    ctx.font = `${Math.max(7, cell * 0.3)}px ${MONO}`
    ctx.textBaseline = 'top'
    ctx.fillText('BLOCKED', px + s / 2, py + s + 2)
  }
}

/** Remaining planned path of the selected robot, dashed in brand color. */
function drawPlannedPath(ctx: CanvasRenderingContext2D, r: Robot, alpha: number, L: MapLayout): void {
  const remaining = r.path.slice(r.pathIndex + 1)
  if (remaining.length === 0) return
  const { cell, ox, oy } = L
  const p = interpXY(r, alpha)
  ctx.save()
  ctx.strokeStyle = C.brand
  ctx.globalAlpha = 0.55
  ctx.lineWidth = Math.max(1.5, cell * 0.09)
  ctx.setLineDash([cell * 0.35, cell * 0.3])
  ctx.beginPath()
  ctx.moveTo(ox + (p.x + 0.5) * cell, oy + (p.y + 0.5) * cell)
  for (const c of remaining) {
    ctx.lineTo(ox + (c.x + 0.5) * cell, oy + (c.y + 0.5) * cell)
  }
  ctx.stroke()
  // Destination marker
  const last = remaining[remaining.length - 1]
  ctx.setLineDash([])
  ctx.globalAlpha = 0.9
  ctx.beginPath()
  ctx.arc(ox + (last.x + 0.5) * cell, oy + (last.y + 0.5) * cell, Math.max(3, cell * 0.18), 0, Math.PI * 2)
  ctx.stroke()
  ctx.restore()
}

function drawFlash(ctx: CanvasRenderingContext2D, f: CommandFlash, L: MapLayout): void {
  const { cell, ox, oy } = L
  const cx = ox + (f.x + 0.5) * cell
  const cy = oy + (f.y + 0.5) * cell
  ctx.save()
  ctx.strokeStyle = C.brand
  ctx.globalAlpha = Math.max(0, 1 - f.age)
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.arc(cx, cy, cell * (0.3 + f.age * 1.3), 0, Math.PI * 2)
  ctx.stroke()
  ctx.restore()
}

function batteryColor(pct: number): string {
  // Same thresholds as the roster: red < 15, amber < 30.
  if (pct < 15) return C.danger
  if (pct < 30) return C.warn
  return C.ok
}

function drawRobot(
  ctx: CanvasRenderingContext2D,
  r: Robot,
  alpha: number,
  L: MapLayout,
  isSelected: boolean,
  isHover: boolean,
): void {
  const { cell, ox, oy } = L
  const p = interpXY(r, alpha)
  const cx = ox + (p.x + 0.5) * cell
  const cy = oy + (p.y + 0.5) * cell
  const size = ROBOT_CLASS_SPECS[r.cls].footprint * cell
  const half = size / 2
  const color = STATE_COLORS[r.state]

  // Selection ring (brand) / hover ring (dim brand), outside the body.
  if (isSelected || isHover) {
    ctx.save()
    ctx.strokeStyle = C.brand
    if (isSelected) {
      ctx.globalAlpha = 0.28
      ctx.lineWidth = 7
      roundRect(ctx, cx - half - 5, cy - half - 5, size + 10, size + 10, Math.min(8, size * 0.3))
      ctx.stroke()
      ctx.globalAlpha = 1
      ctx.lineWidth = 2
      roundRect(ctx, cx - half - 5, cy - half - 5, size + 10, size + 10, Math.min(8, size * 0.3))
      ctx.stroke()
    } else {
      ctx.globalAlpha = 0.6
      ctx.lineWidth = 1.5
      roundRect(ctx, cx - half - 4, cy - half - 4, size + 8, size + 8, Math.min(7, size * 0.28))
      ctx.stroke()
    }
    ctx.restore()
  }

  // Body with state-colored ring
  ctx.fillStyle = '#222B42'
  ctx.strokeStyle = color
  ctx.lineWidth = 2
  roundRect(ctx, cx - half, cy - half, size, size, Math.min(5, size * 0.22))
  ctx.fill()
  ctx.stroke()

  // Battery pip: small bar inside the body, near the bottom
  const bw = size * 0.64
  const bh = Math.max(2.5, size * 0.1)
  const bx = cx - bw / 2
  const by = cy + half - bh - size * 0.12
  ctx.fillStyle = 'rgba(11, 14, 20, 0.6)'
  roundRect(ctx, bx, by, bw, bh, bh / 2)
  ctx.fill()
  ctx.fillStyle = batteryColor(r.battery)
  roundRect(ctx, bx, by, Math.max(bw * (r.battery / 100), bh), bh, bh / 2)
  ctx.fill()

  // ID label above
  ctx.font = `600 ${Math.max(9, cell * 0.42)}px ${MONO}`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'bottom'
  const idW = ctx.measureText(r.id).width
  ctx.fillStyle = 'rgba(11, 14, 20, 0.78)'
  ctx.fillRect(cx - idW / 2 - 3, cy - half - cell * 0.62, idW + 6, cell * 0.55)
  ctx.fillStyle = isSelected ? C.brand : C.text
  ctx.fillText(r.id, cx, cy - half - cell * 0.12)

  // State + battery label below (state is never color-only)
  const label = `${STATE_LABELS[r.state]} ${Math.round(r.battery)}%`
  ctx.font = `${Math.max(8, cell * 0.34)}px ${MONO}`
  ctx.textBaseline = 'top'
  const stW = ctx.measureText(label).width
  ctx.fillStyle = 'rgba(11, 14, 20, 0.78)'
  ctx.fillRect(cx - stW / 2 - 3, cy + half + 2, stW + 6, cell * 0.45)
  ctx.fillStyle = color
  ctx.fillText(label, cx, cy + half + 4)

  // Awaiting-help marker: exclamation badge
  if (r.state === 'awaiting_help') {
    const bxc = cx + half
    const byc = cy - half
    ctx.fillStyle = C.warn
    ctx.beginPath()
    ctx.arc(bxc, byc, Math.max(5, cell * 0.22), 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = '#0B0E14'
    ctx.font = `bold ${Math.max(8, cell * 0.32)}px ${MONO}`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText('!', bxc, byc + 0.5)
  }
}
