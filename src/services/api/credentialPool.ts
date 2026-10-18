export type CredentialPoolFailureKind = 'auth' | 'cooldown'

export type CredentialLease = {
  value: string
  index: number
  generation: number
}

type CredentialState = {
  value: string
  disabled: boolean
  cooldownUntil: number
  lastFailureAt: number
  generation: number
}

export class CredentialPool {
  private credentials: CredentialState[]
  private cursor = 0
  private readonly now: () => number

  constructor(credentials: string[], now: () => number = Date.now) {
    this.credentials = credentials.map(value => ({
      value,
      disabled: false,
      cooldownUntil: 0,
      lastFailureAt: 0,
      generation: 0,
    }))
    this.now = now
  }

  get size(): number {
    return this.credentials.length
  }

  next(): CredentialLease | null {
    if (this.credentials.length === 0) {
      return null
    }

    const now = this.now()
    for (let offset = 0; offset < this.credentials.length; offset++) {
      const index = (this.cursor + offset) % this.credentials.length
      const candidate = this.credentials[index]
      if (!candidate || candidate.disabled || candidate.cooldownUntil > now) {
        continue
      }
      this.cursor = (index + 1) % this.credentials.length
      return { value: candidate.value, index, generation: candidate.generation }
    }

    let leastRecentlyFailedIndex = -1
    let leastRecentlyFailedAt = Number.POSITIVE_INFINITY
    for (let index = 0; index < this.credentials.length; index++) {
      const candidate = this.credentials[index]
      if (!candidate || candidate.disabled) {
        continue
      }
      if (candidate.lastFailureAt < leastRecentlyFailedAt) {
        leastRecentlyFailedAt = candidate.lastFailureAt
        leastRecentlyFailedIndex = index
      }
    }

    if (leastRecentlyFailedIndex === -1) {
      return null
    }

    const fallback = this.credentials[leastRecentlyFailedIndex]
    this.cursor = (leastRecentlyFailedIndex + 1) % this.credentials.length
    return {
      value: fallback.value,
      index: leastRecentlyFailedIndex,
      generation: fallback.generation,
    }
  }

  hasAvailableCredential(): boolean {
    const now = this.now()
    return this.credentials.some(
      credential => !credential.disabled && credential.cooldownUntil <= now,
    )
  }

  reportSuccess(lease: CredentialLease | null): void {
    if (!lease) return
    const credential = this.credentials[lease.index]
    if (
      !credential ||
      credential.value !== lease.value ||
      credential.generation !== lease.generation
    ) {
      return
    }
    credential.cooldownUntil = 0
  }

  reportFailure(
    lease: CredentialLease | null,
    kind: CredentialPoolFailureKind,
    cooldownMs: number,
  ): void {
    if (!lease) return
    const credential = this.credentials[lease.index]
    if (!credential || credential.value !== lease.value) {
      return
    }
    // Auth failures must evict a key even when a newer cooldown advanced its lease.
    if (kind !== 'auth' && credential.generation !== lease.generation) {
      return
    }

    const now = this.now()
    credential.generation += 1
    credential.lastFailureAt = now
    if (kind === 'auth') {
      credential.disabled = true
      credential.cooldownUntil = 0
    } else {
      credential.cooldownUntil = now + Math.max(0, cooldownMs)
    }
  }
}

export function parseCredentialList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean)
}

// Template/dotenv sentinels that must never authenticate or win route
// precedence. Keep this list case-insensitive and shared so dedicated-key
// providers (ApiSmart, AIMLAPI, OpenAI pools) agree with profile sanitizers.
const INVALID_CREDENTIAL_PLACEHOLDERS = new Set([
  'sua_chave',
  'null',
  'undefined',
])

export function isCredentialPlaceholder(value: string | undefined): boolean {
  const trimmed = value?.trim()
  if (!trimmed) {
    return false
  }
  return INVALID_CREDENTIAL_PLACEHOLDERS.has(trimmed.toLowerCase())
}

export function hasInvalidCredentialPlaceholder(value: string | undefined): boolean {
  return parseCredentialList(value).some(credential =>
    isCredentialPlaceholder(credential),
  )
}

export function hasUsableOpenAICredential(value: string | undefined): boolean {
  const credentials = parseCredentialList(value)
  return (
    credentials.length > 0 &&
    credentials.every(credential => !isCredentialPlaceholder(credential))
  )
}

export function firstUsableCredential(value: string | undefined): string | undefined {
  if (hasInvalidCredentialPlaceholder(value)) {
    return undefined
  }

  return parseCredentialList(value)[0]
}
