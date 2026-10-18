import type { GlobalConfig } from '../../utils/config.js'
import {
  formatQueryIdleTimeoutMs,
  parseQueryIdleTimeoutOption,
  QUERY_IDLE_TIMEOUT_OPTIONS_MS,
} from '../../utils/queryGuardConfig.js'

export type QueryIdleTimeoutSetting = {
  id: 'queryIdleTimeoutMs'
  label: 'Query idle timeout'
  value: string
  options: string[]
  type: 'enum'
  onChange(value: string): void
}

type QueryIdleTimeoutSettingDependencies = {
  saveGlobalConfig(
    updater: (currentConfig: GlobalConfig) => GlobalConfig,
  ): void
  getGlobalConfig(): GlobalConfig
  setGlobalConfig(config: GlobalConfig): void
  logChange(timeoutMs: number): void
}

/** Build the interactive `/config` setting and its persistence callback. */
export function createQueryIdleTimeoutSetting(
  globalConfig: GlobalConfig,
  dependencies: QueryIdleTimeoutSettingDependencies,
): QueryIdleTimeoutSetting {
  const value = formatQueryIdleTimeoutMs(globalConfig.queryIdleTimeoutMs)

  return {
    id: 'queryIdleTimeoutMs',
    label: 'Query idle timeout',
    // OPENCLAUDE_QUERY_IDLE_TIMEOUT_MS remains the higher-priority override.
    value,
    options: [
      ...new Set([
        ...QUERY_IDLE_TIMEOUT_OPTIONS_MS.map(formatQueryIdleTimeoutMs),
        value,
      ]),
    ],
    type: 'enum',
    onChange(queryIdleTimeoutOption: string) {
      const queryIdleTimeoutMs = parseQueryIdleTimeoutOption(
        queryIdleTimeoutOption,
      )
      dependencies.saveGlobalConfig(current => ({
        ...current,
        queryIdleTimeoutMs,
      }))
      dependencies.setGlobalConfig({
        ...dependencies.getGlobalConfig(),
        queryIdleTimeoutMs,
      })
      dependencies.logChange(queryIdleTimeoutMs)
    },
  }
}
