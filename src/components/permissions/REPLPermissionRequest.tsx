import React, { useMemo } from 'react'
import { useAppState } from 'src/state/AppState.js'
import { getOriginalCwd } from '../../bootstrap/state.js'
import { Box, Text } from '../../ink.js'
import { shouldShowAlwaysAllowOptions } from '../../utils/permissions/permissionsLoader.js'
import { truncateToLines } from '../../utils/stringUtils.js'
import type { PermissionRequestProps } from './PermissionRequest.js'
import { PermissionPrompt, type PermissionPromptOption } from './PermissionPrompt.js'
import { createSimplePermissionHandlers } from './simplePermissionActions.js'

type ReplOptionValue = 'yes' | 'yes-dont-ask-again' | 'yes-full-access' | 'no'

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

  const options = useMemo(() => {
    const nextOptions: PermissionPromptOption<ReplOptionValue>[] = [
      { label: 'Yes', value: 'yes', feedbackConfig: { type: 'accept' } },
    ]
    if (shouldShowAlwaysAllowOptions()) {
      nextOptions.push({
        label: (
          <Text>
            Yes, and don&apos;t ask again for <Text bold>{userFacingName}</Text> commands in{' '}
            <Text bold>{getOriginalCwd()}</Text>
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
    return nextOptions
  }, [isDangerousModeAvailable, userFacingName])

  return (
    <PermissionPrompt
      toolUseConfirm={toolUseConfirm}
      workerBadge={workerBadge}
      title="Tool use"
      header={
        <Box flexDirection="column" paddingX={2} paddingY={1}>
          <Text>
            {userFacingName} requested permission to execute this exact JavaScript script.
            Inner tools will still use their normal permission checks.
          </Text>
          <Text dimColor>{truncateToLines(toolUseConfirm.description, 3)}</Text>
          <Text>{code}</Text>
        </Box>
      }
      options={options}
      onSelect={onSelect}
      onCancel={onCancel}
    />
  )
}
