import * as React from 'react'
import { Select } from '../../components/CustomSelect/index.js'
import { Dialog } from '../../components/design-system/Dialog.js'
import TextInput from '../../components/TextInput.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { Box, Text, useInput } from '../../ink.js'
import type { LocalJSXCommandCall, LocalJSXCommandOnDone } from '../../types/command.js'
import {
  applySearchSelection,
  describeSearchStatus,
  globalConfigSearchEnvStore,
  hasApiKey,
  isBackendReady,
  needsApiKey,
  parseSearchArgs,
  removeSearchApiKey,
  runSearchTest,
  saveSearchApiKey,
  SEARCH_BACKENDS,
  SEARCH_HELP,
  type SearchBackendOption,
  type SearchEnvStore,
} from './searchSettings.js'

let envStore: SearchEnvStore = globalConfigSearchEnvStore

/** Swap the persistence store (tests only) so nothing reads or writes real config. */
export function setSearchEnvStoreForTests(store: SearchEnvStore | undefined): void {
  envStore = store ?? globalConfigSearchEnvStore
}

/**
 * Masked API-key entry — same UX as /ads and provider keys (TextInput
 * mask="*"), so the key never appears in plaintext.
 */
function ApiKeyDialog({
  option,
  warnExposed,
  onSubmit,
  onCancel,
}: {
  option: SearchBackendOption
  warnExposed: boolean
  onSubmit: (key: string) => void
  onCancel: () => void
}): React.ReactNode {
  const [value, setValue] = React.useState('')
  const [cursorOffset, setCursorOffset] = React.useState(0)
  const { columns } = useTerminalSize()

  useInput((_input, key) => {
    if (key.escape) onCancel()
  })

  return (
    <Box flexDirection="column" gap={1} paddingX={1}>
      <Text bold>{option.label} API key</Text>
      {warnExposed ? (
        <Text color="warning">
          You typed a key on the command line — it&apos;s now visible in your terminal.
          Rotate it and paste the new one here.
        </Text>
      ) : null}
      <Text dimColor>
        Paste your {option.keyEnv}. It stays hidden as you type and is saved to ~/.openclaude.json.
      </Text>
      {option.mode === 'exa' ? (
        <Text dimColor>Get a free key at https://dashboard.exa.ai/api-keys</Text>
      ) : null}
      <Box flexDirection="row" gap={1}>
        <Text>›</Text>
        <TextInput
          value={value}
          onChange={setValue}
          cursorOffset={cursorOffset}
          onChangeCursorOffset={setCursorOffset}
          columns={Math.max(20, columns - 8)}
          mask="*"
          placeholder={option.keyEnv}
          onSubmit={v => {
            const key = v.trim()
            if (key) onSubmit(key)
            else onCancel()
          }}
        />
      </Box>
      <Text dimColor>enter to save · esc to cancel</Text>
    </Box>
  )
}

function backendDescription(option: SearchBackendOption): string {
  if (!option.keyEnv) return option.description
  if (hasApiKey(option)) return `${option.description} · key set`
  if (isBackendReady(option)) return option.description
  return `${option.description} · needs ${option.keyEnv}`
}

type Step =
  | { kind: 'pick' }
  | { kind: 'key-choice'; option: SearchBackendOption }
  | { kind: 'key'; option: SearchBackendOption; setMode: boolean; warnExposed: boolean }

function SearchSetup({
  onDone,
  nativeSearchAvailable,
  initialStep,
}: {
  onDone: LocalJSXCommandOnDone
  nativeSearchAvailable: boolean
  initialStep: Step
}): React.ReactNode {
  const [step, setStep] = React.useState<Step>(initialStep)

  const finish = (message: string): void => onDone(message, { display: 'system' })
  const cancel = (): void => finish('Web search settings unchanged.')

  const select = (option: SearchBackendOption): void => {
    if (needsApiKey(option)) {
      setStep({ kind: 'key', option, setMode: true, warnExposed: false })
      return
    }
    if (option.keyEnv && option.keyOptional) {
      setStep({ kind: 'key-choice', option })
      return
    }
    finish(applySearchSelection(option, undefined, nativeSearchAvailable, envStore))
  }

  if (step.kind === 'key') {
    return (
      <ApiKeyDialog
        option={step.option}
        warnExposed={step.warnExposed}
        onCancel={cancel}
        onSubmit={key =>
          finish(
            step.setMode
              ? applySearchSelection(step.option, key, nativeSearchAvailable, envStore)
              : saveSearchApiKey(step.option, key, nativeSearchAvailable, envStore),
          )
        }
      />
    )
  }

  if (step.kind === 'key-choice') {
    const { option } = step
    const keySet = hasApiKey(option)
    return (
      <Dialog title={`Use ${option.label}`} onCancel={cancel}>
        <Select
          options={[
            {
              label: keySet ? 'Keep the current API key' : `Use it without a key`,
              value: 'keep',
              description:
                option.mode === 'exa' && !keySet
                  ? 'Exa free tier, with per-second and daily limits'
                  : undefined,
            },
            {
              label: keySet ? 'Replace the API key' : 'Add an API key',
              value: 'key',
            },
          ]}
          onChange={value => {
            if (value === 'key') {
              setStep({ kind: 'key', option, setMode: true, warnExposed: false })
            } else {
              finish(applySearchSelection(option, undefined, nativeSearchAvailable, envStore))
            }
          }}
          onCancel={cancel}
        />
      </Dialog>
    )
  }

  return (
    <Dialog
      title="Web search backend"
      subtitle={describeSearchStatus(nativeSearchAvailable)}
      onCancel={cancel}
    >
      <Select
        options={SEARCH_BACKENDS.map(option => ({
          label: option.label,
          value: option.mode,
          description: backendDescription(option),
        }))}
        onChange={mode => {
          const option = SEARCH_BACKENDS.find(b => b.mode === mode)
          if (option) select(option)
        }}
        onCancel={cancel}
      />
    </Dialog>
  )
}

/**
 * `/search` opens the picker; `/search <backend>` selects directly (opening
 * the masked key dialog when the backend needs a key); `/search key` adds or
 * replaces a key and `/search remove-key` deletes one; `/search status` and
 * `/search test` report. Keys are never accepted inline — a key typed on the
 * command line is already exposed in the terminal, so the dialog opens with a
 * rotate warning instead (`isSensitive` keeps inline args out of the
 * transcript).
 */
export const call: LocalJSXCommandCall = async (onDone, context, args) => {
  const action = parseSearchArgs(args ?? '')
  const { hasNativeSearchFallback } = await import(
    '../../tools/WebSearchTool/WebSearchTool.js'
  )
  const nativeSearchAvailable = hasNativeSearchFallback()
  const report = (message: string): null => {
    onDone(message, { display: 'system' })
    return null
  }

  switch (action.kind) {
    case 'help':
      return report(SEARCH_HELP)
    case 'error':
      return report(action.message)
    case 'status':
      return report(describeSearchStatus(nativeSearchAvailable))
    case 'remove-key':
      return report(removeSearchApiKey(action.option, envStore))
    case 'test':
      return report(
        await runSearchTest(
          action.query,
          nativeSearchAvailable,
          undefined,
          context?.abortController?.signal,
        ),
      )
    case 'key':
      return (
        <SearchSetup
          onDone={onDone}
          nativeSearchAvailable={nativeSearchAvailable}
          initialStep={{
            kind: 'key',
            option: action.option,
            setMode: false,
            warnExposed: action.typedInline,
          }}
        />
      )
    case 'set':
      if (action.typedInline && !action.option.keyEnv) {
        return report(
          `Ignored extra text after "${action.option.mode}". If that was an API key, it is now in your terminal — rotate it and add the new one with /search key.`,
        )
      }
      if (action.option.keyEnv && (action.typedInline || needsApiKey(action.option))) {
        return (
          <SearchSetup
            onDone={onDone}
            nativeSearchAvailable={nativeSearchAvailable}
            initialStep={{
              kind: 'key',
              option: action.option,
              setMode: true,
              warnExposed: action.typedInline,
            }}
          />
        )
      }
      return report(applySearchSelection(action.option, undefined, nativeSearchAvailable, envStore))
    case 'picker':
      return (
        <SearchSetup
          onDone={onDone}
          nativeSearchAvailable={nativeSearchAvailable}
          initialStep={{ kind: 'pick' }}
        />
      )
  }
}
