/**
 * Small shared console widgets: state chip, battery bar, progress bar.
 * State and battery are always double-encoded (color + text) per the
 * accessibility rule: never color alone.
 */

import type { RobotState } from '../sim/robot'
import { batteryLevel, ROBOT_STATE_META } from '../derive'

export function StateChip({ state }: { state: RobotState }) {
  const meta = ROBOT_STATE_META[state]
  return (
    <span className={`chip chip-${meta.tone}`}>
      <span className="chip-dot" aria-hidden="true" />
      {meta.label}
    </span>
  )
}

export function BatteryBar({ pct }: { pct: number }) {
  const level = batteryLevel(pct)
  const rounded = Math.round(pct)
  return (
    <div
      className={`batt batt-${level}`}
      role="meter"
      aria-valuenow={rounded}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={`Battery ${rounded} percent`}
    >
      <span className="batt-track" aria-hidden="true">
        <span className="batt-fill" style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} />
      </span>
      <span className="batt-num">{rounded}%</span>
    </div>
  )
}

export function ProgressBar({ fraction, label }: { fraction: number; label: string }) {
  const pct = Math.round(Math.max(0, Math.min(1, fraction)) * 100)
  return (
    <div
      className="prog"
      role="progressbar"
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label}
    >
      <span className="prog-track" aria-hidden="true">
        <span className="prog-fill" style={{ width: `${pct}%` }} />
      </span>
      <span className="prog-num" aria-hidden="true">
        {pct}%
      </span>
    </div>
  )
}
