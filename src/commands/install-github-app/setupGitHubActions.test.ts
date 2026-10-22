import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import type { GlobalConfig } from 'src/utils/config.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'

type BrowserModule = typeof import('../../utils/browser.js')
type ConfigModule = typeof import('../../utils/config.js')
type ExecFileNoThrowModule = typeof import('../../utils/execFileNoThrow.js')

type ExecCall = {
  file: string
  args: string[]
}

type RealModules = {
  browser: BrowserModule
  config: ConfigModule
  execFileNoThrow: ExecFileNoThrowModule
}

const CLAUDE_WORKFLOW_PATH =
  'repos/owner/repo/contents/.github/workflows/claude.yml'
const REVIEW_WORKFLOW_PATH =
  'repos/owner/repo/contents/.github/workflows/claude-code-review.yml'

const execCalls: ExecCall[] = []
const openedUrls: string[] = []
let setupConfig: GlobalConfig
let realModules: RealModules | undefined

function execResult(stdout = '', code = 0, stderr = '') {
  return {
    code,
    stderr,
    stdout,
  }
}

async function importRealModules(): Promise<RealModules> {
  if (realModules) return realModules

  const cacheKey = `${Date.now()}-${Math.random()}`
  realModules = {
    browser: (await import(
      `../../utils/browser.ts?setup-actions-real-${cacheKey}`
    )) as BrowserModule,
    config: {
      ...await import(`../../utils/config.js?real=${cacheKey}`),
    } as ConfigModule,
    execFileNoThrow: (await import(
      `../../utils/execFileNoThrow.ts?setup-actions-real-${cacheKey}`
    )) as ExecFileNoThrowModule,
  }
  return realModules
}

function getWorkflowMessage(path: string): string | null {
  if (path === CLAUDE_WORKFLOW_PATH) return 'Claude PR Assistant workflow'
  if (path === REVIEW_WORKFLOW_PATH) return 'Claude Code Review workflow'
  return null
}

function isBranchName(value: string): boolean {
  return /^add-claude-github-actions-\d+$/.test(value)
}

function workflowWritePaths(): string[] {
  return execCalls
    .filter(
      call =>
        call.args[0] === 'api' &&
        call.args[1] === '--method' &&
        call.args[2] === 'PUT' &&
        call.args[3]?.startsWith(
          'repos/owner/repo/contents/.github/workflows/',
        ),
    )
    .map(call => call.args[3])
}

function handleGhCommand(args: string[]) {
  if (args.join('\0') === ['api', 'repos/owner/repo', '--jq', '.id'].join('\0')) {
    return execResult('123')
  }
  if (
    args.join('\0') ===
    ['api', 'repos/owner/repo', '--jq', '.default_branch'].join('\0')
  ) {
    return execResult('main')
  }
  if (
    args.join('\0') ===
    [
      'api',
      'repos/owner/repo/git/ref/heads/main',
      '--jq',
      '.object.sha',
    ].join('\0')
  ) {
    return execResult('base-sha')
  }

  if (
    args.length === 8 &&
    args[0] === 'api' &&
    args[1] === '--method' &&
    args[2] === 'POST' &&
    args[3] === 'repos/owner/repo/git/refs' &&
    args[4] === '-f' &&
    args[5]?.startsWith('ref=refs/heads/') &&
    isBranchName(args[5].slice('ref=refs/heads/'.length)) &&
    args[6] === '-f' &&
    args[7] === 'sha=base-sha'
  ) {
    return execResult()
  }

  if (
    args.length === 4 &&
    args[0] === 'api' &&
    args[1] === CLAUDE_WORKFLOW_PATH &&
    args[2] === '--jq' &&
    args[3] === '.sha'
  ) {
    return execResult('', 1, 'Not Found')
  }

  if (
    args.length === 4 &&
    args[0] === 'api' &&
    args[1] === REVIEW_WORKFLOW_PATH &&
    args[2] === '--jq' &&
    args[3] === '.sha'
  ) {
    return execResult('', 1, 'Not Found')
  }

  if (
    args.length === 10 &&
    args[0] === 'api' &&
    args[1] === '--method' &&
    args[2] === 'PUT' &&
    getWorkflowMessage(args[3]) &&
    args[4] === '-f' &&
    args[5] === `message="${getWorkflowMessage(args[3])}"` &&
    args[6] === '-f' &&
    args[7]?.startsWith('content=') &&
    args[8] === '-f' &&
    args[9]?.startsWith('branch=') &&
    isBranchName(args[9].slice('branch='.length))
  ) {
    return execResult()
  }

  if (
    args.length === 7 &&
    args[0] === 'secret' &&
    args[1] === 'set' &&
    (args[2] === 'ANTHROPIC_API_KEY' || args[2] === 'CLAUDE_CODE_OAUTH_TOKEN') &&
    args[3] === '--body' &&
    typeof args[4] === 'string' &&
    args[4].length > 0 &&
    args[5] === '--repo' &&
    args[6] === 'owner/repo'
  ) {
    return execResult()
  }

  throw new Error(`Unexpected gh call: ${args.join(' ')}`)
}

function installMocks(real: RealModules): void {
  mock.module('src/utils/config.js', () => ({
    saveGlobalConfig: mock((updater: (current: GlobalConfig) => GlobalConfig) => {
      setupConfig = updater(setupConfig)
    }),
  }))

  mock.module('../../utils/execFileNoThrow.js', () => ({
    ...real.execFileNoThrow,
    execFileNoThrow: mock(async (file: string, args: string[]) => {
      execCalls.push({ file, args })

      if (file === 'gh') {
        return handleGhCommand(args)
      }

      throw new Error(`Unexpected executable: ${file}`)
    }),
  }))

  mock.module('../../utils/browser.js', () => ({
    ...real.browser,
    openBrowser: mock(async (url: string) => {
      openedUrls.push(url)
    }),
  }))
}

async function importSetupGitHubActions() {
  return import(`./setupGitHubActions.ts?test-${Date.now()}-${Math.random()}`)
}

beforeEach(async () => {
  await acquireSharedMutationLock(
    'commands/install-github-app/setupGitHubActions.test.ts',
  )
  execCalls.length = 0
  openedUrls.length = 0
  setupConfig = { numStartups: 0, githubActionSetupCount: 0 } as GlobalConfig
  installMocks(await importRealModules())
})

afterEach(() => {
  try {
    mock.restore()
    if (realModules) {
      mock.module('src/utils/config.js', () => realModules!.config)
      mock.module('../../utils/config.js', () => realModules!.config)
      mock.module(
        '../../utils/execFileNoThrow.js',
        () => realModules!.execFileNoThrow,
      )
      mock.module('../../utils/browser.js', () => realModules!.browser)
    }
  } finally {
    releaseSharedMutationLock()
  }
})

test('setupGitHubActions creates only the selected review workflow', async () => {
  const { setupGitHubActions } = await importSetupGitHubActions()

  await setupGitHubActions(
    'owner/repo',
    'api-token',
    'ANTHROPIC_API_KEY',
    () => {},
    false,
    ['claude-review'],
    'api_key',
  )

  const secretSet = execCalls.find(call =>
    call.args.includes('secret') && call.args.includes('set'),
  )

  expect(workflowWritePaths()).toEqual([REVIEW_WORKFLOW_PATH])
  expect(secretSet?.args).toContain('ANTHROPIC_API_KEY')
  expect(secretSet?.args).toContain('api-token')
  expect(openedUrls).toHaveLength(1)
  expect(openedUrls[0]).toContain(
    'https://github.com/owner/repo/compare/main...add-claude-github-actions-',
  )
  expect(setupConfig.githubActionSetupCount).toBe(1)
})

test('setupGitHubActions skip mode configures the secret without workflow writes', async () => {
  const { setupGitHubActions } = await importSetupGitHubActions()

  await setupGitHubActions(
    'owner/repo',
    'oauth-token',
    'CLAUDE_CODE_OAUTH_TOKEN',
    () => {},
    true,
    ['claude', 'claude-review'],
    'oauth_token',
  )

  const branchCreates = execCalls.filter(call =>
    call.args.includes('repos/owner/repo/git/refs'),
  )
  const secretSet = execCalls.find(call =>
    call.args.includes('secret') && call.args.includes('set'),
  )

  expect(branchCreates).toHaveLength(0)
  expect(workflowWritePaths()).toEqual([])
  expect(openedUrls).toHaveLength(0)
  expect(secretSet?.args).toContain('CLAUDE_CODE_OAUTH_TOKEN')
  expect(secretSet?.args).toContain('oauth-token')
  expect(setupConfig.githubActionSetupCount).toBe(1)
})
