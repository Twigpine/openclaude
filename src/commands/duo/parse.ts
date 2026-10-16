/**
 * /duo — argument parsing and model resolution (pure helpers, no I/O).
 */

import {
  DUO_MAX_ROUNDS,
  type DuoBackend,
  type DuoState,
  type DuoSide,
} from '../../services/duo/types.js'

export type DuoInput =
  | { verb: 'status' }
  | { verb: 'clear' }
  | { verb: 'models' }
  | { verb: 'skills' }
  | { verb: 'skill'; skill: string; question: string; error?: string }
  | { verb: 'run'; question: string }
  | { verb: 'rounds'; rounds: number; error?: string }
  | { verb: 'protocol'; on: boolean; error?: string }
  | { verb: 'auto'; on: boolean; error?: string }
  | { verb: 'grounded'; on: boolean; error?: string }
  | { verb: 'adversarial'; on: boolean; error?: string }
  | { verb: 'backend'; backend: DuoBackend; error?: string }
  | { verb: 'approve'; on: boolean; error?: string }
  | { verb: 'model'; side: DuoSide; model: string; error?: string }
  | { verb: 'budget'; type: 'tokens' | 'usd' | 'wall' | 'off'; value?: number; error?: string }
  | { verb: 'save'; name: string; error?: string }
  | { verb: 'load'; name: string; error?: string }
  | { verb: 'sessions' }
  | { verb: 'delete'; name: string; error?: string }

const MAX_ROUNDS = DUO_MAX_ROUNDS

/** Parse the raw argument string of /duo into a command intent. */
export function parseDuoInput(raw: string): DuoInput {
  const trimmed = raw.trim()
  if (!trimmed) return { verb: 'status' }

  const first = trimmed.split(/\s+/, 1)[0]!.toLowerCase()
  const rest = trimmed.slice(trimmed.split(/\s+/, 1)[0]!.length).trim()

  switch (first) {
    case 'status':
    case 'models':
    case 'skills':
    case 'clear': {
      // `/duo status of my auth flow` is a question, not a subcommand.
      if (rest) return { verb: 'run', question: trimmed }
      return { verb: first as 'status' | 'models' | 'skills' | 'clear' }
    }
    case 'skill': {
      const parts = rest.split(/\s+/).filter(Boolean)
      if (parts.length === 0) {
        return { verb: 'skill', skill: '', question: '', error: 'usage: /duo skill <name> <question>' }
      }
      const skill = parts[0]!
      const question = parts.slice(1).join(' ')
      if (!question) {
        return {
          verb: 'skill',
          skill,
          question: '',
          error: `usage: /duo skill ${skill} <question>`,
        }
      }
      return { verb: 'skill', skill, question }
    }
    case 'backend': {
      const v = rest.toLowerCase()
      if (v === 'builtin') return { verb: 'backend', backend: 'builtin' }
      if (v === 'cli') return { verb: 'backend', backend: 'cli' }
      return { verb: 'backend', backend: 'builtin', error: 'usage: /duo backend builtin|cli' }
    }
    case 'approve': {
      const v = rest.toLowerCase()
      if (v === 'on') return { verb: 'approve', on: true }
      if (v === 'off') return { verb: 'approve', on: false }
      return { verb: 'approve', on: false, error: 'usage: /duo approve on|off' }
    }
    case 'auto': {
      const v = rest.toLowerCase()
      if (v === 'on') return { verb: 'auto', on: true }
      if (v === 'off') return { verb: 'auto', on: false }
      return { verb: 'auto', on: false, error: 'usage: /duo auto on|off' }
    }
    case 'tools': {
      const v = rest.toLowerCase()
      if (v === 'on') return { verb: 'grounded', on: true }
      if (v === 'off') return { verb: 'grounded', on: false }
      return { verb: 'grounded', on: false, error: 'usage: /duo tools on|off' }
    }
    case 'mode': {
      const v = rest.toLowerCase()
      if (v === 'adversarial') return { verb: 'adversarial', on: true }
      if (v === 'neutral') return { verb: 'adversarial', on: false }
      return { verb: 'adversarial', on: true, error: 'usage: /duo mode adversarial|neutral' }
    }
    case 'budget': {
      const parts = rest.split(/\s+/).filter(Boolean)
      if (parts.length === 0) {
        return { verb: 'budget', type: 'tokens', error: 'usage: /duo budget tokens|usd|wall <value>' }
      }
      const sub = parts[0]!.toLowerCase()
      if (sub === 'tokens') {
        const n = Number.parseInt(parts[1] ?? '', 10)
        if (!Number.isInteger(n) || n <= 0) {
          return { verb: 'budget', type: 'tokens', error: 'usage: /duo budget tokens <positive-integer>' }
        }
        return { verb: 'budget', type: 'tokens', value: n }
      }
      if (sub === 'usd') {
        const n = Number.parseFloat(parts[1] ?? '')
        if (!Number.isFinite(n) || n <= 0) {
          return { verb: 'budget', type: 'usd', error: 'usage: /duo budget usd <positive-number>' }
        }
        return { verb: 'budget', type: 'usd', value: n }
      }
      if (sub === 'wall') {
        const n = Number.parseInt(parts[1] ?? '', 10)
        if (!Number.isInteger(n) || n <= 0) {
          return { verb: 'budget', type: 'wall', error: 'usage: /duo budget wall <minutes>' }
        }
        return { verb: 'budget', type: 'wall', value: n * 60000 } // minutes to ms
      }
      if (sub === 'off') {
        return { verb: 'budget', type: 'off' }
      }
      return { verb: 'budget', type: 'tokens', error: 'usage: /duo budget tokens|usd|wall <value> | off' }
    }
    case 'save': {
      const name = rest.trim()
      if (!name) return { verb: 'save', name: '', error: 'usage: /duo save <name>' }
      return { verb: 'save', name }
    }
    case 'load': {
      const name = rest.trim()
      if (!name) return { verb: 'load', name: '', error: 'usage: /duo load <name>' }
      return { verb: 'load', name }
    }
    case 'sessions': {
      return { verb: 'sessions' }
    }
    case 'delete': {
      const name = rest.trim()
      if (!name) return { verb: 'delete', name: '', error: 'usage: /duo delete <name>' }
      return { verb: 'delete', name }
    }
    case 'rounds': {
      const n = Number.parseInt(rest, 10)
      if (!Number.isInteger(n) || `${n}` !== rest || n < 0 || n > MAX_ROUNDS) {
        return {
          verb: 'rounds',
          rounds: 0,
          error: `rounds must be an integer between 0 and ${MAX_ROUNDS} (got "${rest}")`,
        }
      }
      return { verb: 'rounds', rounds: n }
    }
    case 'protocol': {
      const v = rest.toLowerCase()
      if (v === 'on') return { verb: 'protocol', on: true }
      if (v === 'off') return { verb: 'protocol', on: false }
      return { verb: 'protocol', on: false, error: 'usage: /duo protocol on|off' }
    }
    case 'model': {
      const parts = rest.split(/\s+/).filter(Boolean)
      const lower = parts.map(part => part.toLowerCase())
      if (parts.length === 2 && (lower[0] === 'a' || lower[0] === 'b')) {
        const side: DuoSide = lower[0] === 'a' ? 'A' : 'B'
        const model = parts[1]!
        if (!isValidModelId(model)) {
          return { verb: 'model', side, model, error: `invalid model id "${model}"` }
        }
        return { verb: 'model', side, model }
      }
      if (parts.length === 1) {
        const model = parts[0]!
        // `/duo model a` is a side without a model, not a model named "a".
        if (lower[0] === 'a' || lower[0] === 'b') {
          return {
            verb: 'model',
            side: 'B',
            model: '',
            error: `usage: /duo model ${lower[0]} <model-id>`,
          }
        }
        if (!isValidModelId(model)) {
          return { verb: 'model', side: 'B', model, error: `invalid model id "${model}"` }
        }
        // Single id sets side B (the peer of the session default, side A).
        return { verb: 'model', side: 'B', model }
      }
      return {
        verb: 'model',
        side: 'B',
        model: '',
        error: 'usage: /duo model a|b <model-id> (or /duo model <id> for side B)',
      }
    }
    default:
      return { verb: 'run', question: trimmed }
  }
}

/** Resolve the model string for one side. Null config = session default. */
export function resolveDuoModel(
  side: DuoSide,
  st: DuoState,
  sessionModel: string,
): string {
  if (side === 'A') return st.modelA ?? sessionModel
  return st.modelB ?? st.modelA ?? sessionModel
}

/** Model ids are passed to CLIs as `-m <id>`; keep flag-shaped input out. */
const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/

export function isValidModelId(value: string): boolean {
  return MODEL_ID_RE.test(value)
}
