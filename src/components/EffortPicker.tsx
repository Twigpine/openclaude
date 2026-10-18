import type { ReactNode } from 'react'
import { Box, Text } from '../ink.js'
import { useMainLoopModel } from '../hooks/useMainLoopModel.js'
import { useAppState, useSetAppState } from '../state/AppState.js'
import type { EffortLevel } from '../utils/effort.js'
import {
  getAvailableEffortLevels,
  getDisplayedEffortLevel,
  getEffortLevelDescription,
  getEffortLevelLabel,
  isOpenAIEffortLevel,
  modelSupportsEffort,
  modelUsesOpenAIEffort,
  openAIEffortToStandard,
} from '../utils/effort.js'
import { getAPIProvider } from '../utils/model/providers.js'
import { getReasoningEffortForModel } from '../services/api/providerConfig.js'
import { Select } from './CustomSelect/select.js'
import { effortLevelToSymbol } from './EffortIndicator.js'
import { KeyboardShortcutHint } from './design-system/KeyboardShortcutHint.js'
import { Byline } from './design-system/Byline.js'

type EffortOption = {
  label: ReactNode
  value: string
  description: string
  isAvailable: boolean
}

type Props = {
  onSelect: (effort: EffortLevel | undefined) => void
  onCancel?: () => void
}

export function EffortPicker({ onSelect, onCancel }: Props) {
  const model = useMainLoopModel()
  const appStateEffort = useAppState((s) => s.effortValue)
  const setAppState = useSetAppState()
  const provider = getAPIProvider()
  const usesOpenAIEffort = modelUsesOpenAIEffort(model)
  const availableLevels = getAvailableEffortLevels(model)
  const currentDisplayedLevel = getDisplayedEffortLevel(model, appStateEffort)

  // For OpenAI/Codex, get the model's default reasoning effort
  const modelReasoningEffort = usesOpenAIEffort ? getReasoningEffortForModel(model) : undefined
  const options: EffortOption[] = [
    {
      label: <EffortOptionLabel level="auto" text="Auto" isCurrent={false} />,
      value: 'auto',
      description: 'Use the default effort level for your model',
      isAvailable: true,
    },
    ...availableLevels.map(level => {
      // xhigh is now the persisted level for OpenAI/Codex, so compare against
      // it directly. The 'max' alias path is kept only for legacy settings
      // that still hold a persisted 'max' from before xhigh was introduced.
      const isCurrent = currentDisplayedLevel === level || (usesOpenAIEffort && level === 'xhigh' && currentDisplayedLevel === 'max')
      return {
        label: (
          <EffortOptionLabel
            level={level as EffortLevel}
            text={getEffortLevelLabel(level as EffortLevel)}
            isCurrent={isCurrent}
          />
        ),
        value: level,
        description: getEffortLevelDescription(level as EffortLevel),
        isAvailable: true,
      }
    }),
  ]

  function handleSelect(value: string) {
    if (value === 'auto') {
      setAppState(prev => ({
        ...prev,
        effortValue: undefined,
      }))
      onSelect(undefined)
    } else {
      // Normalize OpenAI-shaped effort to a standard EffortLevel for AppState
      // and settings.json persistence. 'xhigh' passes through as-is; the shim
      // converts it to 'max' at the Anthropic request boundary if needed.
      const effortLevel = isOpenAIEffortLevel(value)
        ? openAIEffortToStandard(value)
        : (value as EffortLevel)
      setAppState(prev => ({
        ...prev,
        effortValue: effortLevel,
      }))
      onSelect(effortLevel)
    }
  }

  function handleCancel() {
    onCancel?.()
  }

  const supportsEffort = modelSupportsEffort(model)
  // For OpenAI/Codex: prefer the user's current selection (max → xhigh for
  // option matching), otherwise the model's alias default, otherwise auto.
  // For Claude: user's current selection or auto.
  const initialFocus = usesOpenAIEffort
    ? (appStateEffort === 'max'
        ? 'xhigh'
        : appStateEffort
          ? String(appStateEffort)
          : (modelReasoningEffort || 'auto'))
    : (appStateEffort ? String(appStateEffort) : 'auto')

  return (
    <Box flexDirection="column">
      <Box marginBottom={1} flexDirection="column">
        <Text color="remember" bold={true}>Set effort level</Text>
        <Text dimColor={true}>
            {supportsEffort && usesOpenAIEffort
              ? `OpenAI/Codex provider (${provider})`
              : supportsEffort
              ? `Claude model · ${provider} provider`
              : `Effort not supported for this model`
          }
        </Text>
      </Box>

      <Box marginBottom={1}>
        <Select
          options={options}
          defaultValue={initialFocus}
          onChange={handleSelect}
          onCancel={handleCancel}
          visibleOptionCount={Math.min(6, options.length)}
          inlineDescriptions={true}
        />
      </Box>

      <Box marginBottom={1}>
        <Text dimColor={true} italic={true}>
          <Byline>
            <KeyboardShortcutHint shortcut="Enter" action="confirm" />
            <KeyboardShortcutHint shortcut="Esc" action="cancel" />
          </Byline>
        </Text>
      </Box>
    </Box>
  )
}

function EffortOptionLabel({ level, text, isCurrent }: { level: EffortLevel | 'auto', text: string, isCurrent: boolean }) {
  const symbol = level === 'auto' ? '⊘' : effortLevelToSymbol(level as EffortLevel)
  const color = isCurrent ? 'remember' : level === 'auto' ? 'subtle' : 'suggestion'

  return (
    <>
      <Text color={color}>{symbol} </Text>
      <Text bold={isCurrent}>{text}</Text>
      {isCurrent && <Text dimColor={true}> (current)</Text>}
    </>
  )
}
