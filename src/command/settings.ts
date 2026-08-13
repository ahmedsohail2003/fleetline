/**
 * Command-console settings persisted in localStorage — and only there.
 *
 * The Gemini API key never leaves the browser except in requests the user's
 * own browser makes directly to generativelanguage.googleapis.com; there is
 * no backend. Without a key the console runs entirely on the grammar parser.
 * All access is guarded so these helpers are safe to import in tests (no DOM).
 */

import { DEFAULT_MODEL } from './llm'
import type { LlmSettings } from './llm'

const KEY_API = 'fleetline.llm.apiKey'
const KEY_MODEL = 'fleetline.llm.model'
const KEY_SPOKEN = 'fleetline.voice.spokenReplies'

function read(key: string): string | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null
  } catch {
    return null
  }
}

function write(key: string, value: string | null): void {
  try {
    if (typeof localStorage === 'undefined') return
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch {
    // Storage unavailable (private mode, etc.) — settings just don't persist.
  }
}

export function getLlmSettings(): LlmSettings {
  return {
    apiKey: read(KEY_API) ?? '',
    model: read(KEY_MODEL)?.trim() || DEFAULT_MODEL,
  }
}

export function saveApiKey(key: string): void {
  write(KEY_API, key.trim() === '' ? null : key.trim())
}

export function saveModel(model: string): void {
  const m = model.trim()
  write(KEY_MODEL, m === '' || m === DEFAULT_MODEL ? null : m)
}

export function getSpokenReplies(): boolean {
  return read(KEY_SPOKEN) === 'on'
}

export function saveSpokenReplies(on: boolean): void {
  write(KEY_SPOKEN, on ? 'on' : null)
}
