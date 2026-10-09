import type { FileStateCache } from '../../utils/fileStateCache.js'
import type { ThemeName } from '../../utils/theme.js'

export type TipContext = {
  theme: ThemeName
  readFileState?: FileStateCache
  bashTools?: Set<string>
  /**
   * The viewer's latest prompt text, used ONLY by the opt-in Twigpine earning
   * tip to fetch a contextually-matched sponsored ad. Sent to the ads partner
   * only when sponsored tips are enabled (which discloses this sharing), and
   * sanitized at the client boundary before it leaves the process.
   */
  latestUserMessage?: string
}

export type TipSponsor = {
  name: string
  url?: string
  label?: string
}

export type Tip = {
  id: string
  content: (ctx: TipContext) => Promise<string>
  cooldownSessions: number
  isRelevant: (ctx?: TipContext) => Promise<boolean>
  sponsor?: TipSponsor
}
