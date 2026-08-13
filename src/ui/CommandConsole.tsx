/**
 * COMMAND CONSOLE (bottom dock): the 'chat' modality of the two-arm command
 * design (see CommandSource in sim/sim.ts). Natural-language input — typed or
 * push-to-talk voice — flows through one pipeline:
 *
 *   utterance -> interpreter (grammar parser, or LLM with grammar fallback)
 *             -> ParseResult (command | clarification | unknown)
 *             -> safety gate (destructive commands need an inline confirm)
 *             -> executor -> response bubble + event log ('operator' tag)
 *
 * Every response bubble shows what was understood (a human sentence), which
 * engine parsed it (GRAMMAR or LLM provenance chip), and the per-robot
 * results. Ambiguity comes back as a question with clickable options;
 * unparseable input gets a "here's what I can do" list, never a shrug.
 *
 * Keyboard: '/' focuses the input from anywhere. Voice: hold the TALK button
 * or hold Space in the empty input (Web Speech API where available; the
 * console degrades gracefully without it). Spoken confirmations via
 * speechSynthesis are toggleable.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { FormEvent, KeyboardEvent as ReactKeyboardEvent } from 'react'
import { fleetStore } from '../store'
import { makeParserContext, parseCommand } from '../command/parser'
import { interpretWithLlm } from '../command/llm'
import type { LlmSettings } from '../command/llm'
import {
  confirmationPrompt,
  describeCommand,
  effectiveCommand,
  executeCommand,
  isDestructive,
} from '../command/executor'
import type { ExecLine } from '../command/executor'
import type { ClarifyOption, Command, Engine, ParseResult } from '../command/types'
import { getLlmSettings, getSpokenReplies, saveApiKey, saveModel, saveSpokenReplies } from '../command/settings'
import { DEMO_CHAT_CANCEL_EVENT, DEMO_CHAT_EVENT } from '../demo/controller'
import { TYPE_MS_PER_CHAR, TYPE_SUBMIT_PAUSE_MS } from '../demo/script'

// ---------------------------------------------------------------------------
// Web Speech API (not in TS's DOM lib yet — minimal local typing)
// ---------------------------------------------------------------------------

interface SpeechRecognitionEventLike {
  resultIndex: number
  results: ArrayLike<{ isFinal: boolean; 0: { transcript: string }; length: number }>
}
interface SpeechRecognitionLike {
  lang: string
  continuous: boolean
  interimResults: boolean
  onresult: ((e: SpeechRecognitionEventLike) => void) | null
  onend: (() => void) | null
  onerror: ((e: { error?: string }) => void) | null
  start(): void
  stop(): void
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike

function speechRecognitionCtor(): SpeechRecognitionCtor | undefined {
  if (typeof window === 'undefined') return undefined
  const w = window as unknown as Record<string, unknown>
  return (w.SpeechRecognition ?? w.webkitSpeechRecognition) as SpeechRecognitionCtor | undefined
}

// ---------------------------------------------------------------------------
// Message model
// ---------------------------------------------------------------------------

interface ConfirmState {
  command: Command
  prompt: string
  state: 'pending' | 'confirmed' | 'cancelled'
  note?: string
}

interface ChatMsg {
  id: number
  role: 'user' | 'console'
  text?: string
  engine?: Engine
  /** Human restatement of the interpreted command. */
  understood?: string
  lines?: ExecLine[]
  clarify?: { question: string; options: ClarifyOption[] }
  confirm?: ConfirmState
  /** Render the "here's what I can do" example list. */
  examples?: boolean
  /** Prefix the examples with "I didn't catch that" (unparseable input). */
  misheard?: boolean
  /** Small italic footnote (e.g. LLM fallback reason). */
  note?: string
  pending?: boolean
}

/** Example commands built from the live fleet, so they stay valid when the
 * roster changes (e.g. robots discovered over the ROS bridge). */
function examplesFor(robotIds: string[]): string[] {
  const a = robotIds[0] ?? 'AMR-1'
  const b = robotIds[1] ?? a
  const c = robotIds[2] ?? a
  return [
    `send ${a} to PACK-1`,
    `send ${b} to packing`,
    `send ${c} to charge`,
    'pause robots in aisle 2',
    `resume ${a}`,
    `status of ${b}`,
    `reroute ${a}`,
    `abort task on ${b}`,
    'e-stop all',
    'clear e-stop',
  ]
}

const MAX_MSGS = 80

function confirmLabel(cmd: Command): string {
  switch (cmd.kind) {
    case 'estop_all':
      return 'CONFIRM E-STOP'
    case 'clear_estop':
      return 'CONFIRM RELEASE'
    default:
      return 'CONFIRM ABORT'
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function CommandConsole() {
  useSyncExternalStore(fleetStore.subscribe, fleetStore.getSnapshot)
  const sim = fleetStore.sim
  // The parser vocabulary tracks the live roster: robots added dynamically
  // (ROS-bridge discovery) become addressable the moment they appear.
  const robotIdsKey = sim.robots.map((r) => r.id).join(',')
  const ctx = useMemo(
    () => makeParserContext(robotIdsKey === '' ? [] : robotIdsKey.split(',')),
    [robotIdsKey],
  )
  const examples = useMemo(() => examplesFor(ctx.robotIds), [ctx])

  const [expanded, setExpanded] = useState(true)
  const [msgs, setMsgs] = useState<ChatMsg[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [llm, setLlm] = useState<LlmSettings>(() => getLlmSettings())
  const [spokenReplies, setSpokenReplies] = useState(() => getSpokenReplies())
  const [listening, setListening] = useState(false)
  const [interim, setInterim] = useState('')

  const seqRef = useRef(0)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  const recRef = useRef<SpeechRecognitionLike | null>(null)
  const finalTranscriptRef = useRef('')

  const voiceAvailable = useMemo(() => speechRecognitionCtor() !== undefined, [])
  const speechOutAvailable = typeof window !== 'undefined' && 'speechSynthesis' in window
  const llmMode = llm.apiKey !== ''

  // Guided-demo hook: the demo "types" its example command keystroke by
  // keystroke into the real input, then submits it through the exact same
  // pipeline as a human sentence — parser, safety gate, executor, provenance
  // chip. No shortcut path exists for the demo.
  const submitRef = useRef<(raw: string) => Promise<void>>(async () => {})
  useEffect(() => {
    let typing: number | undefined
    let submitTimer: number | undefined
    const onDemoChat = (e: Event): void => {
      const text = (e as CustomEvent<{ text?: string }>).detail?.text
      if (!text) return
      setExpanded(true)
      setSettingsOpen(false)
      window.clearInterval(typing)
      let i = 0
      typing = window.setInterval(() => {
        i++
        setInput(text.slice(0, i))
        if (i >= text.length) {
          window.clearInterval(typing)
          submitTimer = window.setTimeout(() => {
            void submitRef.current(text)
          }, TYPE_SUBMIT_PAUSE_MS)
        }
      }, TYPE_MS_PER_CHAR)
    }
    const onDemoCancel = (): void => {
      // Demo handed over mid-type: stop typing, never submit half a sentence.
      window.clearInterval(typing)
      window.clearTimeout(submitTimer)
    }
    window.addEventListener(DEMO_CHAT_EVENT, onDemoChat)
    window.addEventListener(DEMO_CHAT_CANCEL_EVENT, onDemoCancel)
    return () => {
      window.removeEventListener(DEMO_CHAT_EVENT, onDemoChat)
      window.removeEventListener(DEMO_CHAT_CANCEL_EVENT, onDemoCancel)
      window.clearInterval(typing)
      window.clearTimeout(submitTimer)
    }
  }, [])

  // '/' focuses the console from anywhere (except other text fields).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== '/') return
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return
      e.preventDefault()
      setExpanded(true)
      requestAnimationFrame(() => inputRef.current?.focus())
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Keep the newest bubble in view.
  const lastId = msgs.length > 0 ? msgs[msgs.length - 1].id : -1
  useLayoutEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [lastId, expanded])

  const pushMsg = (m: Omit<ChatMsg, 'id'>): number => {
    const id = ++seqRef.current
    setMsgs((ms) => [...ms.slice(-(MAX_MSGS - 1)), { ...m, id }])
    return id
  }

  const patchMsg = (id: number, patch: Partial<ChatMsg>): void => {
    setMsgs((ms) => ms.map((m) => (m.id === id ? { ...m, ...patch } : m)))
  }

  const speak = (text: string): void => {
    if (!spokenReplies || !speechOutAvailable || text === '') return
    window.speechSynthesis.cancel()
    const u = new SpeechSynthesisUtterance(text)
    u.rate = 1.05
    window.speechSynthesis.speak(u)
  }

  /** A newer command supersedes any confirmation still waiting — a stale
   * "CONFIRM E-STOP" button must not fire long after the moment has passed. */
  const supersedePendingConfirms = (): void => {
    setMsgs((ms) =>
      ms.map((m) =>
        m.confirm?.state === 'pending'
          ? { ...m, confirm: { ...m.confirm, state: 'cancelled', note: 'SUPERSEDED — not executed' } }
          : m,
      ),
    )
  }

  const runCommand = (cmd: Command, engine: Engine, note?: string, msgId?: number): void => {
    const outcome = executeCommand(fleetStore, cmd)
    const payload: Partial<ChatMsg> = {
      role: 'console',
      engine,
      understood: describeCommand(cmd),
      lines: outcome.lines,
      note,
      pending: false,
    }
    if (msgId !== undefined) patchMsg(msgId, payload)
    else pushMsg(payload as Omit<ChatMsg, 'id'>)
    speak(outcome.speech)
  }

  const handleResult = (result: ParseResult, engine: Engine, note?: string, msgId?: number): void => {
    const emit = (payload: Omit<ChatMsg, 'id'>): void => {
      if (msgId !== undefined) patchMsg(msgId, { ...payload, pending: false })
      else pushMsg(payload)
    }
    if (result.type === 'unknown') {
      emit({ role: 'console', engine, examples: true, misheard: true, note })
      speak("I didn't catch that. See the command list.")
      return
    }
    if (result.type === 'clarify') {
      emit({ role: 'console', engine, clarify: { question: result.question, options: result.options }, note })
      speak(result.question)
      return
    }
    const cmd = effectiveCommand(fleetStore, result.command)
    if (cmd.kind === 'help') {
      emit({ role: 'console', engine, examples: true, note })
      return
    }
    if (isDestructive(cmd)) {
      emit({
        role: 'console',
        engine,
        understood: describeCommand(cmd),
        confirm: { command: cmd, prompt: confirmationPrompt(fleetStore, cmd), state: 'pending' },
        note,
      })
      speak(`Confirm required. ${confirmationPrompt(fleetStore, cmd)}`)
      return
    }
    runCommand(cmd, engine, note, msgId)
  }

  const submit = async (raw: string): Promise<void> => {
    const text = raw.trim()
    if (text === '' || busy) return
    supersedePendingConfirms()
    pushMsg({ role: 'user', text })
    setInput('')

    if (!llmMode) {
      handleResult(parseCommand(text, ctx), 'grammar')
      return
    }

    const pendingId = pushMsg({ role: 'console', pending: true, text: `Interpreting via ${llm.model}…` })
    setBusy(true)
    try {
      const out = await interpretWithLlm(text, llm, ctx)
      if (out.source === 'llm') {
        handleResult(out.result, 'llm', out.retried ? 'validated after one corrective re-prompt' : undefined, pendingId)
      } else {
        handleResult(parseCommand(text, ctx), 'grammar', `LLM unavailable (${out.reason}) — grammar fallback`, pendingId)
      }
    } finally {
      setBusy(false)
    }
  }
  submitRef.current = submit

  const onConfirm = (id: number, confirm: ConfirmState): void => {
    fleetStore.logOperator(`confirmed — ${describeCommand(confirm.command)}`)
    const outcome = executeCommand(fleetStore, confirm.command)
    setMsgs((ms) =>
      ms.map((m) =>
        m.id === id ? { ...m, confirm: { ...confirm, state: 'confirmed' }, lines: outcome.lines } : m,
      ),
    )
    speak(outcome.speech)
  }

  const onCancel = (id: number, confirm: ConfirmState): void => {
    fleetStore.logOperator(`cancelled — ${describeCommand(confirm.command)}`)
    patchMsg(id, { confirm: { ...confirm, state: 'cancelled' } })
  }

  const onClarifyOption = (opt: ClarifyOption): void => {
    // Options are canonical sentences; the deterministic parser settles them.
    supersedePendingConfirms()
    pushMsg({ role: 'user', text: opt.input })
    handleResult(parseCommand(opt.input, ctx), 'grammar')
  }

  // --- Push-to-talk -----------------------------------------------------

  const startListening = (): void => {
    if (listening || busy) return
    const Ctor = speechRecognitionCtor()
    if (!Ctor) return
    const rec = new Ctor()
    rec.lang = 'en-US'
    rec.continuous = true
    rec.interimResults = true
    finalTranscriptRef.current = ''
    rec.onresult = (e) => {
      let interimText = ''
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i]
        if (res.isFinal) finalTranscriptRef.current += res[0].transcript
        else interimText += res[0].transcript
      }
      setInterim(`${finalTranscriptRef.current}${interimText}`.trim())
    }
    rec.onerror = (e) => {
      if (e.error !== 'aborted' && e.error !== 'no-speech') {
        pushMsg({ role: 'console', text: `Voice input failed (${e.error ?? 'unknown error'}) — you can keep typing.` })
      }
    }
    rec.onend = () => {
      setListening(false)
      setInterim('')
      recRef.current = null
      const finalText = finalTranscriptRef.current.trim()
      if (finalText !== '') void submit(finalText)
    }
    recRef.current = rec
    setListening(true)
    rec.start()
  }

  const stopListening = (): void => {
    recRef.current?.stop()
  }

  const onInputKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Escape') {
      ;(e.target as HTMLInputElement).blur()
      return
    }
    // Hold Space in the empty input = push-to-talk (documented in the hint).
    if (e.key === ' ' && input === '' && voiceAvailable && !e.repeat) {
      e.preventDefault()
      startListening()
    }
  }

  const onInputKeyUp = (e: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (e.key === ' ' && listening) stopListening()
  }

  const onSubmit = (e: FormEvent): void => {
    e.preventDefault()
    void submit(input)
  }

  // --- Render -------------------------------------------------------------

  if (!expanded) {
    return (
      <section className="cmdc cmdc-collapsed" aria-label="Command console (collapsed)">
        <header className="cmdc-head">
          <h2>COMMAND CONSOLE</h2>
          <span className={`chip ${llmMode ? 'chip-charging' : 'chip-moving'}`}>
            <span className="chip-dot" aria-hidden="true" />
            {llmMode ? 'LLM + FALLBACK' : 'GRAMMAR · OFFLINE'}
          </span>
          <span className="cmdc-hint">
            natural-language fleet control — press <kbd>/</kbd> to focus
          </span>
          <span className="spacer" />
          <button type="button" className="btn" onClick={() => setExpanded(true)}>
            EXPAND
          </button>
        </header>
      </section>
    )
  }

  return (
    <section className="cmdc" aria-label="Command console">
      <header className="cmdc-head">
        <h2>COMMAND CONSOLE</h2>
        <span
          className={`chip ${llmMode ? 'chip-charging' : 'chip-moving'}`}
          title={
            llmMode
              ? `Input is interpreted by ${llm.model}; invalid output falls back to the deterministic grammar parser`
              : 'No API key set — input is interpreted by the deterministic grammar parser (works offline)'
          }
        >
          <span className="chip-dot" aria-hidden="true" />
          {llmMode ? 'LLM + FALLBACK' : 'GRAMMAR · OFFLINE'}
        </span>
        <span className="cmdc-hint">
          <kbd>/</kbd> focus · hold <kbd>SPACE</kbd> or TALK for voice{voiceAvailable ? '' : ' (unavailable in this browser)'}
        </span>
        <span className="spacer" />
        <button
          type="button"
          className="btn btn-toggle"
          aria-pressed={spokenReplies}
          disabled={!speechOutAvailable}
          title={
            speechOutAvailable
              ? 'Speak command confirmations aloud'
              : 'Speech synthesis is unavailable in this browser'
          }
          onClick={() => {
            setSpokenReplies((v) => {
              saveSpokenReplies(!v)
              return !v
            })
          }}
        >
          SPOKEN REPLIES <b>{spokenReplies ? 'ON' : 'OFF'}</b>
        </button>
        <button
          type="button"
          className="btn"
          aria-expanded={settingsOpen}
          onClick={() => setSettingsOpen((v) => !v)}
        >
          LLM SETTINGS
        </button>
        <button type="button" className="btn" onClick={() => setExpanded(false)}>
          COLLAPSE
        </button>
      </header>

      {settingsOpen && (
        <SettingsPopover
          llm={llm}
          onChange={(next) => setLlm(next)}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      <div className="cmdc-msgs" ref={listRef} role="log" aria-label="Command console conversation">
        {msgs.length === 0 ? (
          <div className="cmdc-empty">
            Type a command for the fleet — try <button type="button" className="cm-eg-inline" onClick={() => { setInput(`send ${ctx.robotIds[0] ?? 'AMR-1'} to RECEIVING`); inputRef.current?.focus() }}>send {ctx.robotIds[0] ?? 'AMR-1'} to RECEIVING</button> — or type <span className="cm-mono">help</span> for the full list.
          </div>
        ) : (
          msgs.map((m) =>
            m.role === 'user' ? (
              <div key={m.id} className="cm-row cm-row-user">
                <span className="cm-bubble cm-user-bubble">{m.text}</span>
              </div>
            ) : (
              <div key={m.id} className="cm-row">
                <div className={`cm-bubble cm-console-bubble ${m.pending ? 'cm-pending' : ''}`}>
                  {m.pending ? (
                    <span className="cm-note">{m.text}</span>
                  ) : (
                    <>
                      {(m.understood !== undefined || m.clarify !== undefined || m.engine !== undefined) && (
                        <div className="cm-resp-head">
                          <span className="cm-understood">{m.understood ?? m.clarify?.question ?? ''}</span>
                          {m.engine !== undefined && (
                            <span
                              className={`engine-chip engine-${m.engine}`}
                              title={
                                m.engine === 'grammar'
                                  ? 'Interpreted by the deterministic grammar parser'
                                  : 'Interpreted by the LLM (schema-validated)'
                              }
                            >
                              {m.engine === 'grammar' ? 'GRAMMAR' : 'LLM'}
                            </span>
                          )}
                        </div>
                      )}
                      {m.text !== undefined && <span className="cm-plain">{m.text}</span>}
                      {m.lines !== undefined && m.lines.length > 0 && (
                        <ul className="cm-lines">
                          {m.lines.map((l, i) => (
                            <li key={i} className={`cm-line ${l.ok ? 'cm-line-ok' : 'cm-line-err'}`}>
                              <span className="cm-line-mark" aria-hidden="true">
                                {l.ok ? '✓' : '✕'}
                              </span>
                              <span className="visually-hidden">{l.ok ? 'done:' : 'refused:'}</span>
                              {l.text}
                            </li>
                          ))}
                        </ul>
                      )}
                      {m.clarify !== undefined && m.clarify.options.length > 0 && (
                        <div className="cm-clarify-opts">
                          {m.clarify.options.map((o) => (
                            <button key={o.input} type="button" className="cm-opt" onClick={() => onClarifyOption(o)}>
                              {o.label}
                            </button>
                          ))}
                        </div>
                      )}
                      {m.confirm !== undefined && (
                        <div className="cm-confirm">
                          {m.confirm.state === 'pending' && <span className="cm-confirm-q">{m.confirm.prompt}</span>}
                          {m.confirm.state === 'pending' ? (
                            <div className="cm-confirm-btns">
                              <button
                                type="button"
                                className="btn btn-dangerline"
                                onClick={() => onConfirm(m.id, m.confirm!)}
                              >
                                {confirmLabel(m.confirm.command)}
                              </button>
                              <button type="button" className="btn" onClick={() => onCancel(m.id, m.confirm!)}>
                                CANCEL
                              </button>
                            </div>
                          ) : (
                            <span className={`cm-confirm-state ${m.confirm.state === 'confirmed' ? 'cm-state-ok' : 'cm-state-dim'}`}>
                              {m.confirm.state === 'confirmed' ? 'CONFIRMED' : m.confirm.note ?? 'CANCELLED — nothing executed'}
                            </span>
                          )}
                        </div>
                      )}
                      {m.examples && (
                        <div className="cm-examples">
                          <span className="cm-plain">
                            {m.misheard ? "I didn't catch that. " : ''}Here's what I can do — click one to try it:
                          </span>
                          {examples.map((ex) => (
                            <button
                              key={ex}
                              type="button"
                              className="cm-eg"
                              onClick={() => {
                                setInput(ex)
                                inputRef.current?.focus()
                              }}
                            >
                              {ex}
                            </button>
                          ))}
                        </div>
                      )}
                      {m.note !== undefined && <span className="cm-note">{m.note}</span>}
                    </>
                  )}
                </div>
              </div>
            ),
          )
        )}
      </div>

      <form className="cmdc-inputrow" onSubmit={onSubmit}>
        <button
          type="button"
          className={`btn ptt-btn ${listening ? 'ptt-live' : ''}`}
          disabled={!voiceAvailable || busy}
          title={
            voiceAvailable
              ? 'Hold to talk — release to send the transcript through the command pipeline'
              : 'Voice input is unavailable in this browser (Web Speech API not supported)'
          }
          onMouseDown={startListening}
          onMouseUp={stopListening}
          onMouseLeave={() => listening && stopListening()}
          onTouchStart={(e) => {
            e.preventDefault()
            startListening()
          }}
          onTouchEnd={stopListening}
          onKeyDown={(e) => {
            if (e.key === ' ' || e.key === 'Enter') e.preventDefault()
          }}
        >
          {listening ? '● LISTENING' : voiceAvailable ? 'HOLD TO TALK' : 'VOICE N/A'}
        </button>
        <label className="visually-hidden" htmlFor="cmdc-input">
          Fleet command
        </label>
        <input
          id="cmdc-input"
          ref={inputRef}
          className={`cmdc-input ${listening ? 'cm-interim' : ''}`}
          value={listening ? interim || '…listening' : input}
          readOnly={listening}
          placeholder={`Command the fleet — e.g. "send ${ctx.robotIds[0] ?? 'AMR-1'} to PACK-1" · "pause robots in aisle 2" · "status of ${ctx.robotIds[ctx.robotIds.length - 1] ?? 'AMR-1'}"`}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onInputKeyDown}
          onKeyUp={onInputKeyUp}
        />
        <button type="submit" className="btn" disabled={busy || listening || input.trim() === ''}>
          SEND
        </button>
      </form>
      <span className="visually-hidden" role="status">
        {listening ? 'Listening for a voice command' : ''}
      </span>
    </section>
  )
}

// ---------------------------------------------------------------------------
// Settings popover
// ---------------------------------------------------------------------------

function SettingsPopover({
  llm,
  onChange,
  onClose,
}: {
  llm: LlmSettings
  onChange: (next: LlmSettings) => void
  onClose: () => void
}) {
  const [key, setKey] = useState(llm.apiKey)
  const [model, setModel] = useState(llm.model)

  const apply = (): void => {
    saveApiKey(key)
    saveModel(model)
    onChange(getLlmSettings())
    onClose()
  }

  return (
    <div className="cmdc-settings" role="dialog" aria-label="Command interpreter settings">
      <div className="set-head">
        <h3>INTERPRETER SETTINGS</h3>
        <span className="spacer" />
        <button type="button" className="btn" onClick={onClose}>
          CLOSE
        </button>
      </div>
      <p className="set-note">
        Without a key, the console uses its built-in deterministic grammar parser — everything works offline.
        With a Gemini API key, input is interpreted by the model first; output is schema-validated, corrected
        once on failure, and falls back to the grammar parser.
      </p>
      <div className="set-field">
        <label htmlFor="set-key">GEMINI API KEY — stays in your browser (localStorage only)</label>
        <input
          id="set-key"
          type="password"
          value={key}
          autoComplete="off"
          placeholder="paste key, or leave empty for grammar-only mode"
          onChange={(e) => setKey(e.target.value)}
        />
      </div>
      <div className="set-field">
        <label htmlFor="set-model">MODEL ID</label>
        <input id="set-model" type="text" value={model} autoComplete="off" onChange={(e) => setModel(e.target.value)} />
      </div>
      <p className="set-note">
        The key is sent only with requests your browser makes directly to generativelanguage.googleapis.com —
        there is no backend. Clear the field and apply to remove it.
      </p>
      <div className="set-actions">
        <button type="button" className="btn btn-okline" onClick={apply}>
          APPLY
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => {
            setKey('')
            setModel(llm.model)
          }}
        >
          CLEAR KEY
        </button>
      </div>
    </div>
  )
}
