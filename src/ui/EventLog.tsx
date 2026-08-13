/**
 * EVENT LOG (right panel, bottom): the fleet's timestamped record.
 *
 * Auto-scrolls while the operator is at the bottom; the moment they scroll
 * up to read history, auto-scroll stops and a "jump to latest" affordance
 * appears (a log that yanks the scroll position while being read is worse
 * than no log). Filter chips narrow to task flow, alerts, or operator
 * actions. Mono type, color-coded tags — color is never the only encoding;
 * every line carries its text tag.
 */

import { useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { fleetStore } from '../store'
import { EVENT_FILTERS, EVENT_META, matchesFilter } from '../derive'
import type { EventFilter } from '../derive'

const MAX_ROWS = 250

export default function EventLog() {
  useSyncExternalStore(fleetStore.subscribe, fleetStore.getSnapshot)
  const sim = fleetStore.sim
  const [filter, setFilter] = useState<EventFilter>('all')
  const listRef = useRef<HTMLDivElement | null>(null)
  const atBottomRef = useRef(true)
  const [showJump, setShowJump] = useState(false)

  const rows = sim.events.events.filter((e) => matchesFilter(e, filter)).slice(-MAX_ROWS)
  const lastSeq = rows.length > 0 ? rows[rows.length - 1].seq : -1

  useLayoutEffect(() => {
    const el = listRef.current
    if (el && atBottomRef.current) el.scrollTop = el.scrollHeight
  }, [lastSeq, filter])

  const onScroll = (): void => {
    const el = listRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 16
    atBottomRef.current = atBottom
    setShowJump(!atBottom)
  }

  const jumpToLatest = (): void => {
    const el = listRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    atBottomRef.current = true
    setShowJump(false)
  }

  return (
    <section className="eventlog" aria-label="Event log">
      <header className="panel-head">
        <h2>EVENT LOG</h2>
        <div className="chips" role="group" aria-label="Filter events">
          {EVENT_FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              className={`fchip ${filter === f.id ? 'fchip-on' : ''}`}
              aria-pressed={filter === f.id}
              onClick={() => setFilter(f.id)}
            >
              {f.label}
            </button>
          ))}
        </div>
      </header>
      <div className="log-wrap">
        <div className="log-list" ref={listRef} onScroll={onScroll} role="log" aria-label="Fleet events">
          {rows.length === 0 ? (
            <div className="log-empty">No events match this filter yet.</div>
          ) : (
            rows.map((ev) => {
              const meta = EVENT_META[ev.type]
              return (
                <div key={ev.seq} className="log-row">
                  <span className="log-time">{ev.clock}</span>
                  <span className={`log-tag tone-${meta.tone}`}>{meta.tag}</span>
                  <span className="log-msg">{ev.message}</span>
                </div>
              )
            })
          )}
        </div>
        {showJump && (
          <button type="button" className="log-jump" onClick={jumpToLatest}>
            ↓ JUMP TO LATEST
          </button>
        )}
      </div>
    </section>
  )
}
