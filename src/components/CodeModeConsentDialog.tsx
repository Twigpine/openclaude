import React from 'react'
import { Box, Text } from '../ink.js'
import { CODE_MODE_ENV_VAR } from '../tools/REPLTool/constants.js'
import { Select } from './CustomSelect/index.js'
import { Dialog } from './design-system/Dialog.js'

type Props = {
  onDone: (accepted: boolean) => void
}

export function CodeModeConsentDialog({ onDone }: Props): React.ReactNode {
  return (
    <Dialog
      title="Enable experimental Code Mode?"
      color="warning"
      onCancel={() => onDone(false)}
    >
      <Box flexDirection="column" gap={1}>
        <Text>
          Code Mode is experimental. It lets the model write JavaScript that
          orchestrates available tools in this interactive terminal session.
        </Text>
        <Text>
          Availability is provider-neutral, but generated-code quality depends
          on the active model. REPL permission rules control each script, and
          inner tool calls keep their normal names, hooks, and permission
          prompts.
        </Text>
        <Text>
          {`A session that uses Code Mode can be resumed only when ${CODE_MODE_ENV_VAR} is enabled. This acknowledgement is remembered; the environment setting is still required for each Code Mode session.`}
        </Text>
        <Select
          options={[
            {
              value: 'enable',
              label: 'Enable experimental Code Mode',
            },
            {
              value: 'decline',
              label: 'Do not enable Code Mode',
            },
          ]}
          onChange={value => onDone(value === 'enable')}
          onCancel={() => onDone(false)}
        />
      </Box>
    </Dialog>
  )
}
