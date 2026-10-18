import { feature } from 'bun:bundle';
import {
  BACKGROUND_SESSION_CLEANUP_WORKER_ENV,
  BACKGROUND_SESSION_ID_ENV,
  BACKGROUND_SESSION_LAUNCHER_PID_ENV,
} from '../cli/bgRouting.js'
import { applyChildProcessHeapOptions } from './applyChildProcessHeapOptions.js'
import {
  argsBeforeModelOwningSubcommand,
  parseRootOptionValue,
} from '../utils/printFlag.js'

// Defensive compatibility guard for environments where globalThis.File is
// unexpectedly absent. OpenClaude's supported runtime is Node >=22; this is
// not a Node 18 support guarantee. The guard is harmless on supported Node
// versions and prevents undici's module evaluation from throwing in unusual
// embedded/runtime setups.
// eslint-disable-next-line custom-rules/no-top-level-side-effects
if (typeof globalThis.File === 'undefined') {
  try {
    // Some runtimes expose File in node:buffer but not as a global.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { File: NodeFile } = require('node:buffer')
    globalThis.File = NodeFile
  } catch {
    // Absolute fallback: stub so `MakeTypeAssertion(File)` doesn't throw.
    // @ts-expect-error -- minimal polyfill
    globalThis.File = class File extends Blob {
      name: string
      lastModified: number
      constructor(parts: BlobPart[], name: string, opts?: FilePropertyBag) {
        super(parts, opts)
        this.name = name
        this.lastModified = opts?.lastModified ?? Date.now()
      }
    }
  }
}

// OpenClaude: disable experimental API betas by default.
// Tool search (defer_loading), global cache scope, and context management
// require internal API support not available to external accounts → 500.
// Users can opt-in with CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=false.
// eslint-disable-next-line custom-rules/no-top-level-side-effects
process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS ??= 'true'

// Bugfix for corepack auto-pinning, which adds yarnpkg to peoples' package.jsons
// eslint-disable-next-line custom-rules/no-top-level-side-effects
process.env.COREPACK_ENABLE_AUTO_PIN = '0';

const SKILLS_LEADING_BOOLEAN_FLAGS = new Set([
  '--bare',
  '--debug',
  '--debug-to-stderr',
  '--yolo', // alias for --dangerously-skip-permissions
  '--dangerously-skip-permissions',
  '--allow-dangerously-skip-permissions',
  '--disable-slash-commands',
  '--enable-auth-status',
  '--fork-session',
  '--ide',
  '--include-hook-events',
  '--include-partial-messages',
  '--init',
  '--init-only',
  '--maintenance',
  '--mcp-debug',
  '--no-chrome',
  '--no-session-persistence',
  '--replay-user-messages',
  '--strict-mcp-config',
  '--verbose',
])

const SKILLS_LEADING_VALUE_FLAGS = new Set([
  '--agent',
  '--append-system-prompt',
  '--append-system-prompt-file',
  '--debug-file',
  '--effort',
  '--fallback-model',
  '--heartbeat',
  '--input-format',
  '--json-schema',
  '--max-budget-usd',
  '--max-thinking-tokens',
  '--max-turns',
  '--model',
  '--output-format',
  '--permission-mode',
  '--permission-prompt-tool',
  '--provider',
  '--resume-session-at',
  '--session-id',
  '--settings',
  '--setting-sources',
  '--system-prompt',
  '--system-prompt-file',
  '--thinking',
  '--workload',
  '-n',
  '--name',
])

const SKILLS_LEADING_OPTIONAL_VALUE_FLAGS = new Set([
  '--continue',
  '--from-pr',
  '--print',
  '-c',
  '-p',
  '-r',
  '--resume',
])

const SKILLS_LEADING_MULTI_VALUE_FLAGS = new Set([
  '--add-dir',
  '--allowedTools',
  '--allowed-tools',
  '--betas',
  '--disallowedTools',
  '--disallowed-tools',
  '--file',
  '--mcp-config',
  '--plugin-dir',
  '--provider-env-file',
  '--tools',
])

type SkillsCliParseResult = {
  additionalDirectories: string[]
  args: string[]
}

function getSkillsCliArgs(args: string[]): SkillsCliParseResult | undefined {
  const additionalDirectories: string[] = []
  let sawPromptModeFlag = false

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === 'skills') {
      if (sawPromptModeFlag) {
        return undefined
      }
      return { additionalDirectories, args: args.slice(index) }
    }
    if (SKILLS_LEADING_BOOLEAN_FLAGS.has(arg)) {
      continue
    }
    if (SKILLS_LEADING_MULTI_VALUE_FLAGS.has(arg)) {
      let consumed = false
      while (args[index + 1] && !args[index + 1]!.startsWith('-')) {
        index += 1
        const value = args[index]
        if (value === 'skills') {
          if (sawPromptModeFlag) {
            return undefined
          }
          return {
            additionalDirectories,
            args: args.slice(index),
          }
        }
        if (value && arg === '--add-dir') {
          additionalDirectories.push(value)
        }
        consumed = true
      }
      if (!consumed) {
        return undefined
      }
      continue
    }
    const multiValueEqualsFlag = Array.from(SKILLS_LEADING_MULTI_VALUE_FLAGS)
      .find(flag => arg?.startsWith(`${flag}=`))
    if (multiValueEqualsFlag) {
      const value = arg.slice(`${multiValueEqualsFlag}=`.length)
      if (!value) {
        return undefined
      }
      if (multiValueEqualsFlag === '--add-dir') {
        additionalDirectories.push(value)
      }
      continue
    }
    if (
      SKILLS_LEADING_VALUE_FLAGS.has(arg) &&
      args[index + 1] &&
      !args[index + 1]!.startsWith('-')
    ) {
      index += 1
      continue
    }
    if (
      Array.from(SKILLS_LEADING_VALUE_FLAGS).some(flag =>
        arg?.startsWith(`${flag}=`),
      )
    ) {
      continue
    }
    if (SKILLS_LEADING_OPTIONAL_VALUE_FLAGS.has(arg)) {
      sawPromptModeFlag = true
      if (
        args[index + 1] &&
        args[index + 1] !== 'skills' &&
        !args[index + 1]!.startsWith('-')
      ) {
        index += 1
      }
      continue
    }
    if (
      Array.from(SKILLS_LEADING_OPTIONAL_VALUE_FLAGS).some(flag =>
        arg?.startsWith(`${flag}=`),
      )
    ) {
      sawPromptModeFlag = true
      continue
    }
    return undefined
  }

  return undefined
}

// Set max heap size for child processes. The current CLI process is already
// running by this point; the package launcher raises its heap before importing
// dist/cli.mjs. Keeping NODE_OPTIONS here preserves the larger cap for tools or
// subprocesses spawned after startup without overriding user-provided limits.
// eslint-disable-next-line custom-rules/no-top-level-side-effects, custom-rules/no-process-env-top-level
applyChildProcessHeapOptions(process.env, process.execArgv)

// Harness-science L0 ablation baseline. Inlined here (not init.ts) because
// BashTool/AgentTool/PowerShellTool capture DISABLE_BACKGROUND_TASKS into
// module-level consts at import time — init() runs too late. feature() gate
// DCEs this entire block from external builds.
// eslint-disable-next-line custom-rules/no-top-level-side-effects, custom-rules/no-process-env-top-level
if (feature('ABLATION_BASELINE') && process.env.CLAUDE_CODE_ABLATION_BASELINE) {
  for (const k of ['CLAUDE_CODE_SIMPLE', 'CLAUDE_CODE_DISABLE_THINKING', 'DISABLE_INTERLEAVED_THINKING', 'DISABLE_COMPACT', 'DISABLE_AUTO_COMPACT', 'CLAUDE_CODE_DISABLE_AUTO_MEMORY', 'CLAUDE_CODE_DISABLE_BACKGROUND_TASKS']) {
    // eslint-disable-next-line custom-rules/no-top-level-side-effects, custom-rules/no-process-env-top-level
    process.env[k] ??= '1';
  }
}

/**
 * Bootstrap entrypoint - checks for special flags before loading the full CLI.
 * All imports are dynamic to minimize module evaluation for fast paths.
 * Fast-path for --version has zero imports beyond this file.
 */
type CliEntrypointOptions = {
  bgSessionsEnabled?: boolean
  importers?: Partial<CliEntrypointImporters>
}

type CliEntrypointImporters = {
  startupProfiler: () => Promise<typeof import('../utils/startupProfiler.js')>
  bg: () => Promise<typeof import('../cli/bg.js')>
  bgFinalizer: () => Promise<typeof import('../cli/bgFinalizer.js')>
  providerFlag: () => Promise<typeof import('../utils/providerFlag.js')>
  envFile: () => Promise<typeof import('../utils/envFile.js')>
  config: () => Promise<typeof import('../utils/config.js')>
  managedEnv: () => Promise<typeof import('../utils/managedEnv.js')>
  providerProfile: () => Promise<typeof import('../utils/providerProfile.js')>
  providerValidation: () => Promise<
    typeof import('../utils/providerValidation.js')
  >
  flagSettings: () => Promise<
    typeof import('../utils/settings/flagSettings.js')
  >
  settingsCache: () => Promise<
    typeof import('../utils/settings/settingsCache.js')
  >
  agentRouting: () => Promise<
    typeof import('../services/api/agentRouting.js')
  >
  settings: () => Promise<typeof import('../utils/settings/settings.js')>
  cliArgs: () => Promise<typeof import('../utils/cliArgs.js')>
  githubModelsCredentials: () => Promise<
    typeof import('../utils/githubModelsCredentials.js')
  >
  startupScreen: () => Promise<typeof import('../components/StartupScreen.js')>
  earlyInput: () => Promise<typeof import('../utils/earlyInput.js')>
  main: () => Promise<typeof import('../main.js')>
}

const defaultCliEntrypointImporters: CliEntrypointImporters = {
  startupProfiler: () => import('../utils/startupProfiler.js'),
  bg: () => import('../cli/bg.js'),
  bgFinalizer: () => import('../cli/bgFinalizer.js'),
  providerFlag: () => import('../utils/providerFlag.js'),
  envFile: () => import('../utils/envFile.js'),
  config: () => import('../utils/config.js'),
  managedEnv: () => import('../utils/managedEnv.js'),
  providerProfile: () => import('../utils/providerProfile.js'),
  providerValidation: () => import('../utils/providerValidation.js'),
  flagSettings: () => import('../utils/settings/flagSettings.js'),
  settingsCache: () => import('../utils/settings/settingsCache.js'),
  agentRouting: () => import('../services/api/agentRouting.js'),
  settings: () => import('../utils/settings/settings.js'),
  cliArgs: () => import('../utils/cliArgs.js'),
  githubModelsCredentials: () =>
    import('../utils/githubModelsCredentials.js'),
  startupScreen: () => import('../components/StartupScreen.js'),
  earlyInput: () => import('../utils/earlyInput.js'),
  main: () => import('../main.js'),
}

function getCliEntrypointImporters(
  overrides: Partial<CliEntrypointImporters> | undefined,
): CliEntrypointImporters {
  return {
    ...defaultCliEntrypointImporters,
    ...overrides,
  }
}

function isBgSessionsEnabled(options: CliEntrypointOptions): boolean {
  if (options.bgSessionsEnabled !== undefined) return options.bgSessionsEnabled
  if (feature('BG_SESSIONS')) return true
  return false
}

export async function main(
  args: string[] = process.argv.slice(2),
  options: CliEntrypointOptions = {},
): Promise<void> {
  const importers = getCliEntrypointImporters(options.importers)
  if (process.env[BACKGROUND_SESSION_CLEANUP_WORKER_ENV] === '1') {
    const { enableConfigs } = await importers.config()
    enableConfigs()
    const { eagerLoadSettingsFromArgs } = await importers.flagSettings()
    const { resetSettingsCache } = await importers.settingsCache()
    const reloadSettings = () => {
      resetSettingsCache()
      return eagerLoadSettingsFromArgs(args).ok
    }
    if (!reloadSettings()) return
    const { runBackgroundSessionCleanupWorker } = await importers.bgFinalizer()
    await runBackgroundSessionCleanupWorker({ reloadSettings })
    return
  }
  // The detached CLI is the registered background-session PID. Establish
  // exact registry ownership and install its terminal finalizer before any
  // fast path or startup validation can call process.exit(). The private env
  // value only routes this check; the registry's exact ID/PID match is the
  // authority.
  if (
    process.env[BACKGROUND_SESSION_ID_ENV] !== undefined ||
    process.env[BACKGROUND_SESSION_LAUNCHER_PID_ENV] !== undefined
  ) {
    const { prepareBackgroundSessionFinalizer } = await importers.bgFinalizer()
    await prepareBackgroundSessionFinalizer()
  }

  const bgSessionsEnabled = isBgSessionsEnabled(options)
  let reapplyProviderEnvFileValues = () => {}
  let reapplyProviderFlagValues = () => {}
  const reapplyExplicitProviderInputs = () => {
    reapplyProviderEnvFileValues()
    reapplyProviderFlagValues()
  }

  // Fast-path for --version/-v: zero module loading needed
  if (args.length === 1 && (args[0] === '--version' || args[0] === '-v' || args[0] === '-V')) {
    // MACRO.VERSION is inlined at build time
    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.log(`${MACRO.DISPLAY_VERSION ?? MACRO.VERSION} (OpenClaude)`);
    return;
  }

  // Fast-path for `openclaude ps|logs|attach|kill`.
  // Session management is entirely local, so it should not require config,
  // profile, credential, provider-validation, or startup-screen work.
  if (bgSessionsEnabled && (args[0] === 'ps' || args[0] === 'logs' || args[0] === 'attach' || args[0] === 'kill')) {
    const {
      profileCheckpoint
    } = await importers.startupProfiler();
    profileCheckpoint('cli_bg_path');
    const bg = await importers.bg();
    switch (args[0]) {
      case 'ps':
        await bg.psHandler(args.slice(1));
        break;
      case 'logs':
        await bg.logsHandler(args.slice(1));
        break;
      case 'attach':
        await bg.attachHandler(args.slice(1));
        break;
      case 'kill':
        {
          const { enableConfigs } = await importers.config()
          enableConfigs()
          const { eagerLoadSettingsFromArgs } = await importers.flagSettings()
          const retentionSettingsReady = eagerLoadSettingsFromArgs(args).ok
          await bg.killHandler(args.slice(1), { retentionSettingsReady });
        }
        break;
    }
    return;
  }

  // --provider-env-file: Load explicit environment files before any provider resolution.
  {
    const {
      loadEnvFile,
      parseProviderEnvFileArgs,
      reapplyRememberedEnvFileValues,
      rememberLoadedEnvFileValues,
    } = await importers.envFile()
    reapplyProviderEnvFileValues = reapplyRememberedEnvFileValues
    const providerEnvFiles = parseProviderEnvFileArgs(args)
    if (providerEnvFiles.error) {
      // biome-ignore lint/suspicious/noConsole:: intentional error output
      console.error(providerEnvFiles.error)
      process.exit(1)
    }
    for (const filePath of providerEnvFiles.paths) {
      try {
        rememberLoadedEnvFileValues(loadEnvFile(filePath))
      } catch (err: unknown) {
        // biome-ignore lint/suspicious/noConsole:: intentional error output
        console.error(err instanceof Error ? err.message : String(err))
        process.exit(1)
      }
    }
  }

  // --provider: set provider env vars early so saved-profile resolution,
  // validation, and the startup banner all see the intended provider/model.
  let appliedExplicitAnthropic = false
  const requestedProvider = parseRootOptionValue(args, '--provider')
  if (requestedProvider) {
    const {
      applyProviderFlagFromArgs,
      reapplyRememberedProviderFlag,
    } = await importers.providerFlag()
    reapplyProviderFlagValues = reapplyRememberedProviderFlag
    const result = applyProviderFlagFromArgs(args, {
      rememberForSettingsEnv: true,
    });
    if (result?.error) {
      // biome-ignore lint/suspicious/noConsole:: intentional error output
      console.error(`Error: ${result.error}`);
      process.exit(1);
    } else if (result && requestedProvider === 'anthropic') {
      appliedExplicitAnthropic = true
    }
  }

  // Enable configs first so we can read settings
  {
    const { enableConfigs } = await importers.config()
    enableConfigs()
  }

  // Apply settings.env from user settings (includes GitHub provider settings from /onboard-github)
  {
    const { applySafeConfigEnvironmentVariables } =
      await importers.managedEnv()
    applySafeConfigEnvironmentVariables()
  }
  reapplyExplicitProviderInputs()

  // Local skills management must stay available even when provider startup
  // configuration is broken, so users can inspect/fix skills from scripts.
  const skillsCliArgs = getSkillsCliArgs(args)
  if (skillsCliArgs) {
    const { setAdditionalDirectoriesForClaudeMd } = await import(
      '../bootstrap/state.js'
    )
    setAdditionalDirectoriesForClaudeMd(skillsCliArgs.additionalDirectories)
    const { runSkillsCli } = await import('../cli/handlers/skillsCli.js')
    process.argv = [process.argv[0]!, process.argv[1]!, ...skillsCliArgs.args]
    await runSkillsCli(skillsCliArgs.args)
    return
  }

  // Pass the full argv into the arity-aware scanners. Required-value options
  // such as --system-prompt consume a following `--` token, so a later root
  // --model must remain visible. parseRootOptionValue still stops at a real
  // end-of-options marker that was not consumed as an option value.
  const modelOptionArgs = argsBeforeModelOwningSubcommand(args)
  const parsedRootModel =
    (await importers.providerFlag()).parseModelFlag(modelOptionArgs) ?? undefined
  const hasRootModelOption = parsedRootModel !== undefined

  const { applyStartupEnvFromProfile } = await importers.providerProfile()
  let startupProfileWarning: string | undefined
  // Built-in Anthropic has no positive CLAUDE_CODE_USE_* flag, so process-env
  // inference cannot preserve an explicit `--provider anthropic` selection.
  // Other providers retain their existing profile/credential recovery path.
  const startupProfileError = appliedExplicitAnthropic
    ? null
    : await applyStartupEnvFromProfile({
        processEnv: process.env,
        modelOverride: parsedRootModel,
        onValidationError: message => {
          startupProfileWarning = message
        },
      })
  let startupProfileIsCommandcodeModelError = false
  if (parsedRootModel && startupProfileError) {
    const { getCommandcodeChatCompletionsModelError } = await import(
      '../integrations/gateways/commandcode.js'
    )
    startupProfileIsCommandcodeModelError =
      startupProfileError ===
      getCommandcodeChatCompletionsModelError(parsedRootModel)
  }
  reapplyExplicitProviderInputs()

  // Pane/window teammates are launched as fresh CLI processes. If the parent
  // selected a configured agentModels key, apply that route before provider
  // validation and --model env routing run in this child process.
  let appliedTeammateModel: string | undefined
  let appliedTeammateProviderOverride = false
  {
    const { eagerLoadSettingsFromArgs } = await importers.flagSettings()
    const settingsLoadResult = eagerLoadSettingsFromArgs(args)
    if (!settingsLoadResult.ok) {
      if (settingsLoadResult.cause instanceof Error) {
        const { logError } = await import('../utils/log.js')
        logError(settingsLoadResult.cause)
      }
      const { default: chalk } = await import('chalk')
      process.stderr.write(chalk.red(`${settingsLoadResult.message}\n`))
      process.exit(1)
    }

    const {
      applyAgentProviderOverrideToEnv,
      resolveOutOfProcessTeammateProviderFromCliArgs,
    } = await importers.agentRouting()
    const { getInitialSettings } = await importers.settings()
    const providerOverride = resolveOutOfProcessTeammateProviderFromCliArgs(
      args,
      getInitialSettings(),
    )
    if (providerOverride) {
      applyAgentProviderOverrideToEnv(providerOverride)
      appliedTeammateModel = providerOverride.model
      appliedTeammateProviderOverride = true
    }
  }

  if (
    startupProfileIsCommandcodeModelError &&
    !appliedTeammateProviderOverride
  ) {
    console.error(`Error: ${startupProfileError}`)
    process.exit(1)
    return
  }
  if (
    startupProfileWarning &&
    !(startupProfileIsCommandcodeModelError && appliedTeammateProviderOverride)
  ) {
    console.error(startupProfileWarning)
  }

  // Fast-path for `--bg`/`--background` after profile routing has been applied
  // so the spawned child inherits the selected provider/model environment.
  if (bgSessionsEnabled) {
    const { argsBeforeDelimiter } = await importers.cliArgs()
    const optionArgs = argsBeforeDelimiter(args)
    if (optionArgs.includes('--bg') || optionArgs.includes('--background')) {
      const {
        profileCheckpoint
      } = await importers.startupProfiler();
      profileCheckpoint('cli_bg_path');
      const bg = await importers.bg();
      await bg.handleBgFlag(args);
      return;
    }
  }

  // Hydrate GitHub credentials after profile is applied so CLAUDE_CODE_USE_GITHUB from profile is available
  {
    const {
      hydrateGithubModelsTokenFromSecureStorage,
      refreshGithubModelsTokenIfNeeded,
    } = await importers.githubModelsCredentials()
    await refreshGithubModelsTokenIfNeeded()
    hydrateGithubModelsTokenFromSecureStorage()
  }

  // #808: --model alone (no --provider) — route to the env var matching the
  // active provider before validation and the banner so the highest-precedence
  // CLI override can replace stale persisted model state.
  let earlyModelFlag: string | undefined
  if (hasRootModelOption) {
    const { applyModelFlagFromArgs } = await importers.providerFlag()
    earlyModelFlag =
      appliedTeammateModel ?? parsedRootModel ?? undefined
    if (!appliedTeammateModel) {
      const result = applyModelFlagFromArgs(modelOptionArgs)
      if (result?.error) {
        console.error(`Error: ${result.error}`)
        process.exit(1)
        return
      }
    }
  }

  const { validateProviderEnvForStartupOrExit } =
    await importers.providerValidation()
  await validateProviderEnvForStartupOrExit()

  // Print the gradient startup screen before the Ink UI loads. Plain CLI
  // management subcommands should stay script-friendly and avoid the banner.
  if (args[0] !== 'skills') {
    const { printStartupScreen } = await importers.startupScreen()
    printStartupScreen(earlyModelFlag)
  }

  // For all other paths, load the startup profiler
  const {
    profileCheckpoint
  } = await importers.startupProfiler();
  profileCheckpoint('cli_entry');

  // Fast-path for --dump-system-prompt: output the rendered system prompt and exit.
  // Used by prompt sensitivity evals to extract the system prompt at a specific commit.
  // Ant-only: eliminated from external builds via feature flag.
  if (feature('DUMP_SYSTEM_PROMPT') && args[0] === '--dump-system-prompt') {
    profileCheckpoint('cli_dump_system_prompt_path');
    const {
      enableConfigs
    } = await import('../utils/config.js');
    enableConfigs();
    const {
      getMainLoopModel
    } = await import('../utils/model/model.js');
    const model = earlyModelFlag ?? getMainLoopModel();
    const {
      getSystemPrompt
    } = await import('../constants/prompts.js');
    const prompt = await getSystemPrompt([], model);
    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.log(prompt.join('\n'));
    return;
  }
  if (process.argv[2] === '--claude-in-chrome-mcp') {
    profileCheckpoint('cli_claude_in_chrome_mcp_path');
    const {
      runClaudeInChromeMcpServer
    } = await import('../utils/claudeInChrome/mcpServer.js');
    await runClaudeInChromeMcpServer();
    return;
  } else if (process.argv[2] === '--chrome-native-host') {
    profileCheckpoint('cli_chrome_native_host_path');
    const {
      runChromeNativeHost
    } = await import('../utils/claudeInChrome/chromeNativeHost.js');
    await runChromeNativeHost();
    return;
  } else if (feature('CHICAGO_MCP') && process.argv[2] === '--computer-use-mcp') {
    profileCheckpoint('cli_computer_use_mcp_path');
    const {
      runComputerUseMcpServer
    } = await import('../utils/computerUse/mcpServer.js');
    await runComputerUseMcpServer();
    return;
  }

  // Fast-path for `--daemon-worker=<kind>` (internal — supervisor spawns this).
  // Must come before the daemon subcommand check: spawned per-worker, so
  // perf-sensitive. No enableConfigs(), no analytics sinks at this layer —
  // workers are lean. If a worker kind needs configs/auth (assistant will),
  // it calls them inside its run() fn.
  if (feature('DAEMON') && args[0] === '--daemon-worker') {
    const {
      runDaemonWorker
    } = await import('../daemon/workerRegistry.js');
    await runDaemonWorker(args[1]);
    return;
  }

  // Fast-path for `claude remote-control` (also accepts legacy `claude remote` / `claude sync` / `claude bridge`):
  // serve local machine as bridge environment.
  // feature() must stay inline for build-time dead code elimination;
  // isBridgeEnabled() checks the runtime GrowthBook gate.
  if (feature('BRIDGE_MODE') && (args[0] === 'remote-control' || args[0] === 'rc' || args[0] === 'remote' || args[0] === 'sync' || args[0] === 'bridge')) {
    profileCheckpoint('cli_bridge_path');
    const {
      enableConfigs
    } = await import('../utils/config.js');
    enableConfigs();
    const {
      getBridgeDisabledReason,
      checkBridgeMinVersion
    } = await import('../bridge/bridgeEnabled.js');
    const {
      BRIDGE_LOGIN_ERROR
    } = await import('../bridge/types.js');
    const {
      bridgeMain
    } = await import('../bridge/bridgeMain.js');
    const {
      exitWithError
    } = await import('../utils/process.js');

    // Auth check must come before the GrowthBook gate check — without auth,
    // GrowthBook has no user context and would return a stale/default false.
    // getBridgeDisabledReason awaits GB init, so the returned value is fresh
    // (not the stale disk cache), but init still needs auth headers to work.
    const {
      getClaudeAIOAuthTokens
    } = await import('../utils/auth.js');
    if (!getClaudeAIOAuthTokens()?.accessToken) {
      exitWithError(BRIDGE_LOGIN_ERROR);
    }
    const disabledReason = await getBridgeDisabledReason();
    if (disabledReason) {
      exitWithError(`Error: ${disabledReason}`);
    }
    const versionError = checkBridgeMinVersion();
    if (versionError) {
      exitWithError(versionError);
    }

    // Bridge is a remote control feature - check policy limits
    const {
      waitForPolicyLimitsToLoad,
      isPolicyAllowed
    } = await import('../services/policyLimits/index.js');
    await waitForPolicyLimitsToLoad();
    if (!isPolicyAllowed('allow_remote_control')) {
      exitWithError("Error: Remote Control is disabled by your organization's policy.");
    }
    await bridgeMain(args.slice(1));
    return;
  }

  // Fast-path for `claude daemon [subcommand]`: long-running supervisor.
  if (feature('DAEMON') && args[0] === 'daemon') {
    profileCheckpoint('cli_daemon_path');
    const {
      enableConfigs
    } = await import('../utils/config.js');
    enableConfigs();
    const {
      initSinks
    } = await import('../utils/sinks.js');
    initSinks();
    const {
      daemonMain
    } = await import('../daemon/main.js');
    await daemonMain(args.slice(1));
    return;
  }

  // Fast-path for template job commands.
  if (feature('TEMPLATES') && (args[0] === 'new' || args[0] === 'list' || args[0] === 'reply')) {
    profileCheckpoint('cli_templates_path');
    const {
      templatesMain
    } = await import('../cli/handlers/templateJobs.js');
    await templatesMain(args);
    // process.exit (not return) — mountFleetView's Ink TUI can leave event
    // loop handles that prevent natural exit.
    // eslint-disable-next-line custom-rules/no-process-exit
    process.exit(0);
  }

  // Fast-path for `claude environment-runner`: headless BYOC runner.
  // feature() must stay inline for build-time dead code elimination.
  if (feature('BYOC_ENVIRONMENT_RUNNER') && args[0] === 'environment-runner') {
    profileCheckpoint('cli_environment_runner_path');
    const {
      environmentRunnerMain
    } = await import('../environment-runner/main.js');
    await environmentRunnerMain(args.slice(1));
    return;
  }

  // Fast-path for `claude self-hosted-runner`: headless self-hosted-runner
  // targeting the SelfHostedRunnerWorkerService API (register + poll; poll IS
  // heartbeat). feature() must stay inline for build-time dead code elimination.
  if (feature('SELF_HOSTED_RUNNER') && args[0] === 'self-hosted-runner') {
    profileCheckpoint('cli_self_hosted_runner_path');
    const {
      selfHostedRunnerMain
    } = await import('../self-hosted-runner/main.js');
    await selfHostedRunnerMain(args.slice(1));
    return;
  }

  // Fast-path for --worktree --tmux: exec into tmux before loading full CLI
  const hasTmuxFlag = args.includes('--tmux') || args.includes('--tmux=classic');
  if (hasTmuxFlag && (args.includes('-w') || args.includes('--worktree') || args.some(a => a.startsWith('--worktree=')))) {
    profileCheckpoint('cli_tmux_worktree_fast_path');
    const {
      enableConfigs
    } = await import('../utils/config.js');
    enableConfigs();
    const {
      isWorktreeModeEnabled
    } = await import('../utils/worktreeModeEnabled.js');
    if (isWorktreeModeEnabled()) {
      const {
        execIntoTmuxWorktree
      } = await import('../utils/worktree.js');
      const result = await execIntoTmuxWorktree(args);
      if (result.handled) {
        return;
      }
      // If not handled (e.g., error), fall through to normal CLI
      if (result.error) {
        const {
          exitWithError
        } = await import('../utils/process.js');
        exitWithError(result.error);
      }
    }
  }

  // Redirect common update flag mistakes to the update subcommand
  if (args.length === 1 && (args[0] === '--update' || args[0] === '--upgrade')) {
    process.argv = [process.argv[0]!, process.argv[1]!, 'update'];
  }

  // --bare: set SIMPLE early so gates fire during module eval / commander
  // option building (not just inside the action handler).
  if (args.includes('--bare')) {
    process.env.CLAUDE_CODE_SIMPLE = '1';
  }

  // No special flags detected, load and run the full CLI
  if (process.env.OPENCLAUDE_DISABLE_EARLY_INPUT !== '1') {
    const {
      startCapturingEarlyInput
    } = await importers.earlyInput();
    startCapturingEarlyInput();
  }
  profileCheckpoint('cli_before_main_import');
  const {
    main: cliMain
  } = await importers.main();
  profileCheckpoint('cli_after_main_import');
  await cliMain();
  profileCheckpoint('cli_after_main_complete');
}

// eslint-disable-next-line custom-rules/no-top-level-side-effects, custom-rules/no-process-env-top-level
if (process.env.OPENCLAUDE_DISABLE_CLI_ENTRYPOINT_AUTO_RUN !== '1') {
  await main();
}
