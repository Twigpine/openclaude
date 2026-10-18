import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import figures from 'figures'
import type { StatusNoticeContext } from './statusNoticeDefinitions.js'
import {
  getActiveNotices,
  statusNoticeDefinitions,
} from './statusNoticeDefinitions.js'
import { renderToString } from './staticRender.js'

// Regression coverage for issue #244 — the two safety-related status notices
// that warn 3P users when they are running without the AI classifier or with
// `--dangerously-skip-permissions` outside a sandbox.

// Empty baseline context (no large-memory/agent-description triggers).
function buildContext(
  overrides?: Partial<StatusNoticeContext>,
): StatusNoticeContext {
  return {
    config: {} as StatusNoticeContext['config'],
    memoryFiles: [],
    ...overrides,
  }
}

function activeIds(ctx: StatusNoticeContext): string[] {
  return getActiveNotices(ctx).map(n => n.id)
}

async function renderNoticePlainText(
  id: string,
  ctx: StatusNoticeContext,
): Promise<string> {
  const notice = statusNoticeDefinitions.find(n => n.id === id)
  expect(notice).toBeDefined()
  return renderToString(notice!.render(ctx), 80)
}

const SAVED_ARGV = process.argv
const SAVED_API_KEY = process.env.ANTHROPIC_API_KEY

beforeEach(() => {
  // Reset argv each test so the dangerously-skip-permissions detector starts
  // from a known baseline.
  process.argv = [
    ...SAVED_ARGV.filter(
      a => a !== '--dangerously-skip-permissions' && a !== '--yolo',
    ),
  ]
  // Other status notices read auth state via getAnthropicApiKeyWithSource,
  // which throws when no key/token is present. Seed a dummy so getActiveNotices
  // can iterate every notice without unrelated failures crashing the test.
  process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? 'sk-test-dummy'
})

afterEach(() => {
  process.argv = SAVED_ARGV
  if (SAVED_API_KEY === undefined) {
    delete process.env.ANTHROPIC_API_KEY
  } else {
    process.env.ANTHROPIC_API_KEY = SAVED_API_KEY
  }
  mock.restore()
})

describe('third-party permissive mode notice (#244 finding 1)', () => {
  test('fires when 3P + acceptEdits + classifier-off model', async () => {
    mock.module('./model/providers.js', () => ({
      getAPIProvider: () => 'openai',
    }))
    mock.module('./betas.js', () => ({
      modelSupportsAutoMode: () => false,
    }))
    const { getActiveNotices: freshGetActiveNotices } = await import(
      `./statusNoticeDefinitions.js?ts=${Date.now()}`
    )
    const ctx = buildContext({ permissionMode: 'acceptEdits', mainLoopModel: 'gpt-5.4' })
    const ids = freshGetActiveNotices(ctx).map((n: { id: string }) => n.id)
    expect(ids).toContain('third-party-permissive-mode')
  })

  test('fires when 3P + bypassPermissions', async () => {
    mock.module('./model/providers.js', () => ({
      getAPIProvider: () => 'openai',
    }))
    mock.module('./betas.js', () => ({
      modelSupportsAutoMode: () => false,
    }))
    const { getActiveNotices: freshGetActiveNotices } = await import(
      `./statusNoticeDefinitions.js?ts=${Date.now()}`
    )
    const ctx = buildContext({ permissionMode: 'bypassPermissions', mainLoopModel: 'llama3.1' })
    const ids = freshGetActiveNotices(ctx).map((n: { id: string }) => n.id)
    expect(ids).toContain('third-party-permissive-mode')
  })

  test('suppressed in default mode even on 3P', async () => {
    mock.module('./model/providers.js', () => ({
      getAPIProvider: () => 'openai',
    }))
    mock.module('./betas.js', () => ({
      modelSupportsAutoMode: () => false,
    }))
    const { getActiveNotices: freshGetActiveNotices } = await import(
      `./statusNoticeDefinitions.js?ts=${Date.now()}`
    )
    const ctx = buildContext({ permissionMode: 'default', mainLoopModel: 'gpt-5.4' })
    const ids = freshGetActiveNotices(ctx).map((n: { id: string }) => n.id)
    expect(ids).not.toContain('third-party-permissive-mode')
  })

  test('suppressed on firstParty Anthropic in acceptEdits', async () => {
    mock.module('./model/providers.js', () => ({
      getAPIProvider: () => 'firstParty',
    }))
    mock.module('./betas.js', () => ({
      modelSupportsAutoMode: () => true,
    }))
    const { getActiveNotices: freshGetActiveNotices } = await import(
      `./statusNoticeDefinitions.js?ts=${Date.now()}`
    )
    const ctx = buildContext({ permissionMode: 'acceptEdits', mainLoopModel: 'claude-opus-4-7' })
    const ids = freshGetActiveNotices(ctx).map((n: { id: string }) => n.id)
    expect(ids).not.toContain('third-party-permissive-mode')
  })

  test('suppressed when classifier supports the model (defensive)', async () => {
    mock.module('./model/providers.js', () => ({
      getAPIProvider: () => 'openai',
    }))
    mock.module('./betas.js', () => ({
      modelSupportsAutoMode: () => true,
    }))
    const { getActiveNotices: freshGetActiveNotices } = await import(
      `./statusNoticeDefinitions.js?ts=${Date.now()}`
    )
    const ctx = buildContext({ permissionMode: 'acceptEdits', mainLoopModel: 'mystery-model' })
    const ids = freshGetActiveNotices(ctx).map((n: { id: string }) => n.id)
    expect(ids).not.toContain('third-party-permissive-mode')
  })
})

describe('dangerously-skip-permissions sandbox notice (#244 finding 2)', () => {
  // The notice is Commander-authoritative: both --dangerously-skip-permissions
  // and its --yolo alias are resolved into permissionMode === 'bypassPermissions'
  // during startup, while --permission-mode fullAccess resolves to 'fullAccess'.
  // The notice keys off the resolved mode, not raw argv.
  test('fires when permission mode is bypassPermissions (either spelling, or settings defaultMode)', () => {
    expect(activeIds(buildContext({ permissionMode: 'bypassPermissions' }))).toContain(
      'dangerously-skip-permissions-no-sandbox',
    )
  })

  test('fires when permission mode is fullAccess', () => {
    expect(activeIds(buildContext({ permissionMode: 'fullAccess' }))).toContain(
      'dangerously-skip-permissions-no-sandbox',
    )
  })

  test('rendered notice names the mode, not a specific flag, so settings-driven bypass is not mislabeled', async () => {
    const notice = await renderNoticePlainText(
      'dangerously-skip-permissions-no-sandbox',
      buildContext({ permissionMode: 'bypassPermissions' }),
    )
    // The notice fires whenever permissionMode is bypassPermissions, which can
    // come from the CLI flags or from a settings defaultMode.
    expect(notice).toContain('bypassPermissions')
    expect(notice).not.toContain('--dangerously-skip-permissions')
    expect(notice).not.toContain('--yolo')
  })

  test('rendered notice names fullAccess when that mode is active', async () => {
    const notice = await renderNoticePlainText(
      'dangerously-skip-permissions-no-sandbox',
      buildContext({ permissionMode: 'fullAccess' }),
    )
    expect(notice).toContain('fullAccess')
    expect(notice).not.toContain('--dangerously-skip-permissions')
    expect(notice).not.toContain('--yolo')
  })

  test('bypassPermissions notice describes bypassed checks with remaining guardrails', async () => {
    const notice = await renderNoticePlainText(
      'dangerously-skip-permissions-no-sandbox',
      buildContext({ permissionMode: 'bypassPermissions' }),
    )
    expect(notice).toContain('Most tool consent checks are bypassed')
    expect(notice).toContain('safety-check guardrails still apply')
    expect(notice).not.toContain('All tool consent checks are bypassed')
  })

  test('fullAccess notice describes the stronger bypass without overstating it', async () => {
    const notice = await renderNoticePlainText(
      'dangerously-skip-permissions-no-sandbox',
      buildContext({ permissionMode: 'fullAccess' }),
    )
    const normalized = notice.replace(/\s+/g, ' ')
    expect(normalized).toContain('Most tool consent checks are bypassed')
    expect(normalized).toContain('including safety-check prompts')
    expect(normalized).toContain('Hard deny rules and user-interaction prompts still apply')
    expect(normalized).not.toContain('All tool consent checks are bypassed')
  })

  test('treats the SDK full-access spelling as the stronger fullAccess bypass', async () => {
    const ctx = buildContext({
      permissionMode: 'full-access' as unknown as StatusNoticeContext['permissionMode'],
    })
    expect(activeIds(ctx)).toContain('dangerously-skip-permissions-no-sandbox')

    const notice = await renderNoticePlainText(
      'dangerously-skip-permissions-no-sandbox',
      ctx,
    )
    const normalized = notice.replace(/\s+/g, ' ')
    expect(normalized).toContain('full-access')
    expect(normalized).toContain('Most tool consent checks are bypassed')
    expect(normalized).toContain('including safety-check prompts')
    expect(normalized).toContain('Hard deny rules and user-interaction prompts still apply')
    expect(normalized).not.toContain('All tool consent checks are bypassed')
  })

  test('does not fire in default mode without the flag', () => {
    expect(activeIds(buildContext({ permissionMode: 'default' }))).not.toContain(
      'dangerously-skip-permissions-no-sandbox',
    )
  })
})

describe('safety notice rendering', () => {
  test('separates warning icons from the notice text', async () => {
    const ctx = buildContext({
      permissionMode: 'bypassPermissions',
      mainLoopModel: 'llama3.1',
    })

    const thirdPartyNotice = await renderNoticePlainText(
      'third-party-permissive-mode',
      ctx,
    )
    const dangerouslySkipNotice = await renderNoticePlainText(
      'dangerously-skip-permissions-no-sandbox',
      ctx,
    )

    expect(thirdPartyNotice).toContain(`${figures.warning} bypassPermissions`)
    expect(thirdPartyNotice).not.toContain(
      `${figures.warning}bypassPermissions`,
    )
    expect(dangerouslySkipNotice).toContain(
      `${figures.warning} bypassPermissions`,
    )
    expect(dangerouslySkipNotice).not.toContain(
      `${figures.warning}bypassPermissions`,
    )
    expect(
      thirdPartyNotice
        .split('\n')
        .slice(1)
        .every(line => line.startsWith('  ')),
    ).toBe(true)
    expect(
      dangerouslySkipNotice
        .split('\n')
        .slice(1)
        .every(line => line.startsWith('  ')),
    ).toBe(true)
  })
})
