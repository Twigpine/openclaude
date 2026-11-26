import React, { useMemo, useState } from 'react'
import { stripVTControlCharacters } from 'node:util'
import { useAppState } from 'src/state/AppState.js'
import { getOriginalCwd } from '../../bootstrap/state.js'
import { Box, Text } from '../../ink.js'
import { shouldShowAlwaysAllowOptions } from '../../utils/permissions/permissionsLoader.js'
import { truncateToLines } from '../../utils/stringUtils.js'
import type { PermissionRequestProps } from './PermissionRequest.js'
import { PermissionPrompt, type PermissionPromptOption } from './PermissionPrompt.js'
import { createSimplePermissionHandlers } from './simplePermissionActions.js'

type ReplOptionValue =
  | 'yes'
  | 'yes-dont-ask-again'
  | 'yes-full-access'
  | 'no'
  | 'toggle-full-script'

const PERMISSION_PREVIEW_BUDGET_CHARS = 8_000
const PERMISSION_PREVIEW_HEAD_CHARS = 6_000
const PERMISSION_PREVIEW_TAIL_CHARS = 1_500

function stripUnsafeControlCharacters(value: string): string {
  return stripVTControlCharacters(value).replace(
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,
    '�',
  )
}

export function formatReplPermissionPreview(code: string): {
  text: string
  fullText: string
  lineCount: number
  characterCount: number
  omittedCharacters: number
} {
  const sanitized = stripUnsafeControlCharacters(code)
  const lineCount = sanitized.length === 0 ? 0 : sanitized.split('\n').length
  if (sanitized.length <= PERMISSION_PREVIEW_BUDGET_CHARS) {
    return {
      text: sanitized,
      fullText: sanitized,
      lineCount,
      characterCount: code.length,
      omittedCharacters: 0,
    }
  }
  const head = sanitized.slice(0, PERMISSION_PREVIEW_HEAD_CHARS)
  const tail = sanitized.slice(-PERMISSION_PREVIEW_TAIL_CHARS)
  const omittedCharacters = sanitized.length - head.length - tail.length
  return {
    text: `${head}\n... [omitted ${omittedCharacters} middle characters] ...\n${tail}`,
    fullText: sanitized,
    lineCount,
    characterCount: code.length,
    omittedCharacters,
  }
}

export function REPLPermissionRequest({
  toolUseConfirm,
  onDone,
  onReject,
  workerBadge,
}: PermissionRequestProps) {
  const isDangerousModeAvailable = useAppState(
    s => s.toolPermissionContext.isBypassPermissionsModeAvailable,
  )
  const input = toolUseConfirm.input as { code?: unknown }
  const code = typeof input.code === 'string' ? input.code : ''
  const preview = useMemo(() => formatReplPermissionPreview(code), [code])
  const [showFullScript, setShowFullScript] = useState(false)
  const userFacingName = toolUseConfirm.tool.userFacingName(toolUseConfirm.input as never)

  const { onSelect, onCancel } = createSimplePermissionHandlers(
    toolUseConfirm,
    { onDone, onReject },
    {
      yes: { behavior: 'allow', includeFeedback: true },
      'yes-dont-ask-again': {
        behavior: 'allow',
        updates: [
          {
            type: 'addRules',
            rules: [{ toolName: toolUseConfirm.tool.name }],
            behavior: 'allow',
            destination: 'localSettings',
          },
        ],
      },
      'yes-full-access': {
        behavior: 'allow',
        updates: [
          { type: 'setMode', mode: 'fullAccess', destination: 'session' },
        ],
      },
      no: { behavior: 'reject', includeFeedback: true },
    },
  )

  const handleSelect = (value: ReplOptionValue, feedback?: string) => {
    if (value === 'toggle-full-script') {
      setShowFullScript(current => !current)
      return
    }
    onSelect(value, feedback)
  }

  const options = useMemo(() => {
    const nextOptions: PermissionPromptOption<ReplOptionValue>[] = [
      { label: 'Yes', value: 'yes', feedbackConfig: { type: 'accept' } },
    ]
    if (shouldShowAlwaysAllowOptions()) {
      nextOptions.push({
        label: (
          <Text>
            Yes, and don&apos;t ask again for all future <Text bold>{userFacingName}</Text>{' '}
            scripts in <Text bold>{getOriginalCwd()}</Text>
          </Text>
        ),
        value: 'yes-dont-ask-again',
      })
    }
    if (isDangerousModeAvailable) {
      nextOptions.push({
        label: <Text color="error">Yes, and enable Full Access for this session</Text>,
        value: 'yes-full-access',
        dangerousMode: 'fullAccess',
      })
    }
    nextOptions.push({
      label: 'No',
      value: 'no',
      feedbackConfig: { type: 'reject' },
    })
    if (preview.omittedCharacters > 0) {
      nextOptions.push({
        label: showFullScript ? 'Show truncated preview' : 'Show full script',
        value: 'toggle-full-script',
      })
    }
    return nextOptions
  }, [
    isDangerousModeAvailable,
    userFacingName,
    preview.omittedCharacters,
    showFullScript,
  ])

  return (
    <PermissionPrompt
      toolUseConfirm={toolUseConfirm}
      workerBadge={workerBadge}
      title="Tool use"
      header={
        <Box flexDirection="column" paddingX={2} paddingY={1}>
          <Text>
            {userFacingName} requested permission to execute this JavaScript script.
            Inner tools will still use their normal permission checks.
          </Text>
          <Text dimColor>{truncateToLines(toolUseConfirm.description, 3)}</Text>
          <Text dimColor>
            {preview.lineCount} lines, {preview.characterCount} characters
            {preview.omittedCharacters > 0 ? `, preview omits ${preview.omittedCharacters} middle characters` : ''}
          </Text>
          <Text>{showFullScript ? preview.fullText : preview.text}</Text>
        </Box>
      }
      options={options}
      onSelect={handleSelect}
      onCancel={onCancel}
    />
  )
}
