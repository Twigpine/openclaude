// Partner roster — mirrors the Partners section of the repo README.
// Logos are self-hosted under /public/partners/.

export interface Partner {
  name: string
  url: string
  logo: string
  /** dark-theme variant, when the primary logo doesn't read on dark */
  logoDark?: string
  /** rendered logo height in px (logos vary wildly in aspect ratio) */
  height: number
}

export const partners: Partner[] = [
  { name: 'Twigpine', url: 'https://twigpine.com', logo: '/partners/twigpine.png', height: 44 },
  { name: 'Bankr.bot', url: 'https://bankr.bot', logo: '/partners/bankr.svg', height: 40 },
  { name: 'Atomic Chat', url: 'https://atomic.chat/', logo: '/partners/atomic-chat-logo.png', height: 40 },
  { name: 'Xiaomi MiMo', url: 'https://mimo.mi.com', logo: '/partners/mimo.svg', height: 30 },
  { name: 'Atlas Cloud', url: 'https://www.atlascloud.ai/', logo: '/partners/atlas-cloud.png', height: 36 },
  {
    name: 'AI/ML API',
    url: 'https://aimlapi.com/',
    logo: '/partners/aimlapi-logo.svg',
    logoDark: '/partners/aimlapi-logo-dark.svg',
    height: 30,
  },
  {
    name: 'Novita AI',
    url: 'https://novita.ai/',
    logo: '/partners/novita-logo.svg',
    logoDark: '/partners/novita-logo-dark.svg',
    height: 26,
  },
  {
    name: 'ApiSmart',
    url: 'https://www.apismart.ai',
    logo: '/partners/apismart-logo.png',
    logoDark: '/partners/apismart-logo-dark.png',
    height: 30,
  },
  {
    name: 'Concentrate',
    url: 'https://concentrate.ai/',
    logo: '/partners/concentrate-logo.svg',
    logoDark: '/partners/concentrate-logo-dark.svg',
    height: 36,
  },
  {
    name: 'Exa',
    url: 'https://exa.ai/',
    logo: '/partners/exa-logo.svg',
    logoDark: '/partners/exa-logo-dark.svg',
    height: 28,
  },
]

export const community = [
  { name: 'github', url: 'https://github.com/Twigpine/openclaude', label: 'star the repo' },
  { name: 'discord', url: 'https://discord.gg/k68zFR6AcB', label: 'join the discord' },
  { name: 'x', url: 'https://x.com/gitlawb', label: 'follow @gitlawb' },
  { name: 'discussions', url: 'https://github.com/Twigpine/openclaude/discussions', label: 'open a discussion' },
  { name: 'trendshift', url: 'https://trendshift.io/repositories/25807', label: 'featured on trendshift' },
]
