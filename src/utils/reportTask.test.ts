import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, posix } from 'node:path'

import { Command as CommanderCommand } from '@commander-js/extra-typings'

import { registerTaskReportCommand } from '../cli/commands/taskReport.js'
import { taskReportHandler } from '../cli/handlers/taskReport.js'
import {
  buildTaskReport,
  collectTaskReportGitMetadata,
  formatTaskReport,
  formatTaskReportAsMarkdown,
  formatTaskReportAsJson,
  type TaskReportGitMetadata,
} from './taskReport.js'

const sessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const cwd = '/workspace/openclaude'

function withTempTranscript(
  entries: Array<Record<string, unknown> | string>,
  fn: (path: string) => Promise<void>,
) {
  const dir = mkdtempSync(join(tmpdir(), 'openclaude-task-report-'))
  const file = join(dir, `${sessionId}.jsonl`)
  writeFileSync(
    file,
    entries
      .map(entry => (typeof entry === 'string' ? entry : JSON.stringify(entry)))
      .join('\n'),
  )

  return fn(file).finally(() => {
    rmSync(dir, { recursive: true, force: true })
  })
}

async function captureStreamWrites(
  stream: NodeJS.WritableStream,
  fn: () => Promise<void>,
): Promise<string> {
  const originalWrite = stream.write
  let output = ''
  ;(stream as { write: (...args: unknown[]) => boolean }).write = (
    chunk: unknown,
    ...args: unknown[]
  ) => {
    output += String(chunk)
    const callback = args.find((arg): arg is (error?: Error) => void =>
      typeof arg === 'function',
    )
    callback?.()
    return true
  }

  try {
    await fn()
  } finally {
    stream.write = originalWrite
  }

  return output
}

function userMessage(
  uuid: string,
  content: unknown,
  timestamp: string,
  messageCwd: string | null = cwd,
) {
  return {
    type: 'user',
    uuid,
    parentUuid: null,
    isSidechain: false,
    ...(messageCwd ? { cwd: messageCwd } : {}),
    sessionId,
    timestamp,
    version: 'test',
    gitBranch: 'feat/source-branch',
    userType: 'external',
    message: {
      role: 'user',
      content,
    },
  }
}

function assistantToolMessage(
  uuid: string,
  toolUse: Record<string, unknown>,
  timestamp: string,
) {
  return {
    type: 'assistant',
    uuid,
    parentUuid: null,
    isSidechain: false,
    cwd,
    sessionId,
    timestamp,
    version: 'test',
    gitBranch: 'feat/source-branch',
    message: {
      role: 'assistant',
      id: `msg-${uuid}`,
      model: 'gpt-5-test',
      content: [
        {
          type: 'tool_use',
          ...toolUse,
        },
      ],
    },
  }
}

function toolResultMessage(
  uuid: string,
  toolUseId: string,
  content: unknown,
  timestamp: string,
  toolUseResult?: unknown,
  isError = false,
) {
  return {
    type: 'user',
    uuid,
    parentUuid: null,
    isSidechain: false,
    cwd,
    sessionId,
    timestamp,
    version: 'test',
    userType: 'external',
    sourceToolAssistantUUID: 'assistant-source',
    toolUseResult,
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: toolUseId,
          content,
          is_error: isError,
        },
      ],
    },
  }
}

function gitMetadata(
  overrides: Partial<TaskReportGitMetadata> = {},
): TaskReportGitMetadata {
  return {
    status: 'available',
    cwd,
    branch: 'feat/session-task-report-json',
    head: '13cf30af',
    dirty: true,
    changedFiles: ['src/report.ts'],
    ...overrides,
  }
}

describe('task report generation', () => {
  test('uses an empty validation list and explicit warning when no validation was observed', async () => {
    await withTempTranscript(
      [
        userMessage(
          '00000000-0000-4000-8000-000000000001',
          'Generate a task report for issue #123.',
          '2026-06-27T08:00:00.000Z',
        ),
      ],
      async transcriptPath => {
        const report = await buildTaskReport({
          transcriptPath,
          git: async () => gitMetadata({ dirty: false, changedFiles: [] }),
        })

        expect(report.schemaVersion).toBe(1)
        expect(report.session.id).toBe(sessionId)
        expect(report.session.cwd).toBe(cwd)
        expect(report.session.initialRequest).toBe(
          'Generate a task report for issue #123.',
        )
        expect(report.validations).toEqual([])
        expect(report.warnings).toContain(
          'No validation commands were observed in this transcript.',
        )
      },
    )
  })

  test('captures passing validation commands from observed Bash results', async () => {
    await withTempTranscript(
      [
        userMessage(
          '00000000-0000-4000-8000-000000000002',
          'Run the checks.',
          '2026-06-27T08:00:00.000Z',
        ),
        assistantToolMessage(
          '00000000-0000-4000-8000-000000000003',
          {
            id: 'tool-validation-pass',
            name: 'Bash',
            input: {
              command: 'bun run typecheck',
              description: 'Run TypeScript checks',
            },
          },
          '2026-06-27T08:01:00.000Z',
        ),
        toolResultMessage(
          '00000000-0000-4000-8000-000000000004',
          'tool-validation-pass',
          'Typecheck passed',
          '2026-06-27T08:01:03.000Z',
          { stdout: 'Typecheck passed\n', stderr: '', interrupted: false },
        ),
      ],
      async transcriptPath => {
        const report = await buildTaskReport({
          transcriptPath,
          git: async () => gitMetadata({ dirty: false, changedFiles: [] }),
        })

        expect(report.commands).toEqual([
          expect.objectContaining({
            toolUseId: 'tool-validation-pass',
            command: 'bun run typecheck',
            description: 'Run TypeScript checks',
            status: 'success',
          }),
        ])
        expect(report.validations).toEqual([
          expect.objectContaining({
            toolUseId: 'tool-validation-pass',
            command: 'bun run typecheck',
            status: 'success',
          }),
        ])
        expect(report.warnings).not.toContain(
          'No validation commands were observed in this transcript.',
        )
      },
    )
  })

  test('captures passing validation commands from observed PowerShell results', async () => {
    await withTempTranscript(
      [
        userMessage(
          '00000000-0000-4000-8000-000000000045',
          'Run the Windows checks.',
          '2026-06-27T08:00:00.000Z',
        ),
        assistantToolMessage(
          '00000000-0000-4000-8000-000000000046',
          {
            id: 'tool-powershell-validation-pass',
            name: 'PowerShell',
            input: {
              command: 'bun run typecheck',
              description: 'Run TypeScript checks',
            },
          },
          '2026-06-27T08:01:00.000Z',
        ),
        toolResultMessage(
          '00000000-0000-4000-8000-000000000047',
          'tool-powershell-validation-pass',
          'Typecheck passed',
          '2026-06-27T08:01:03.000Z',
          { stdout: 'Typecheck passed\n', stderr: '', interrupted: false },
        ),
      ],
      async transcriptPath => {
        const report = await buildTaskReport({
          transcriptPath,
          git: async () => gitMetadata({ dirty: false, changedFiles: [] }),
        })

        expect(report.commands).toEqual([
          expect.objectContaining({
            toolUseId: 'tool-powershell-validation-pass',
            command: 'bun run typecheck',
            description: 'Run TypeScript checks',
            status: 'success',
          }),
        ])
        expect(report.validations).toEqual([
          expect.objectContaining({
            toolUseId: 'tool-powershell-validation-pass',
            command: 'bun run typecheck',
            status: 'success',
          }),
        ])
        expect(report.warnings).not.toContain(
          'No validation commands were observed in this transcript.',
        )
      },
    )
  })

  test('captures failing validation commands with exit code when it is persisted', async () => {
    await withTempTranscript(
      [
        userMessage(
          '00000000-0000-4000-8000-000000000005',
          'Run the failing test.',
          '2026-06-27T08:00:00.000Z',
        ),
        assistantToolMessage(
          '00000000-0000-4000-8000-000000000006',
          {
            id: 'tool-validation-fail',
            name: 'Bash',
            input: {
              command: 'bun test src/utils/reportTask.test.ts',
            },
          },
          '2026-06-27T08:01:00.000Z',
        ),
        toolResultMessage(
          '00000000-0000-4000-8000-000000000007',
          'tool-validation-fail',
          'Error calling tool (Bash): tests failed\nExit code 1',
          '2026-06-27T08:01:03.000Z',
          'Error calling tool (Bash): tests failed\nExit code 1',
          true,
        ),
      ],
      async transcriptPath => {
        const report = await buildTaskReport({
          transcriptPath,
          git: async () => gitMetadata({ dirty: false, changedFiles: [] }),
        })

        expect(report.commands).toEqual([
          expect.objectContaining({
            toolUseId: 'tool-validation-fail',
            command: 'bun test src/utils/reportTask.test.ts',
            status: 'error',
            exitCode: 1,
          }),
        ])
        expect(report.validations).toEqual([
          expect.objectContaining({
            toolUseId: 'tool-validation-fail',
            command: 'bun test src/utils/reportTask.test.ts',
            status: 'error',
            exitCode: 1,
          }),
        ])
        expect(report.errors).toEqual([
          expect.objectContaining({
            source: 'tool',
            toolUseId: 'tool-validation-fail',
            toolName: 'Bash',
          }),
        ])
      },
    )
  })

  test('treats nonzero observed exit code as an error status', async () => {
    await withTempTranscript(
      [
        userMessage(
          '00000000-0000-4000-8000-000000000025',
          'Run a command.',
          '2026-06-27T08:00:00.000Z',
        ),
        assistantToolMessage(
          '00000000-0000-4000-8000-000000000026',
          {
            id: 'tool-command-nonzero',
            name: 'Bash',
            input: {
              command: 'node missing.js',
            },
          },
          '2026-06-27T08:01:00.000Z',
        ),
        toolResultMessage(
          '00000000-0000-4000-8000-000000000027',
          'tool-command-nonzero',
          'Exit code 1',
          '2026-06-27T08:01:03.000Z',
          'Exit code 1',
        ),
      ],
      async transcriptPath => {
        const report = await buildTaskReport({
          transcriptPath,
          git: async () => gitMetadata({ dirty: false, changedFiles: [] }),
        })

        expect(report.toolUses).toEqual([
          expect.objectContaining({
            id: 'tool-command-nonzero',
            status: 'error',
          }),
        ])
        expect(report.commands).toEqual([
          expect.objectContaining({
            toolUseId: 'tool-command-nonzero',
            status: 'error',
            exitCode: 1,
          }),
        ])
      },
    )
  })

  test('captures numeric structured exit codes from observed Bash results', async () => {
    await withTempTranscript(
      [
        userMessage(
          '00000000-0000-4000-8000-000000000028',
          'Run a structured command.',
          '2026-06-27T08:00:00.000Z',
        ),
        assistantToolMessage(
          '00000000-0000-4000-8000-000000000029',
          {
            id: 'tool-command-structured-exit',
            name: 'Bash',
            input: {
              command: 'node missing.js',
            },
          },
          '2026-06-27T08:01:00.000Z',
        ),
        toolResultMessage(
          '00000000-0000-4000-8000-000000000030',
          'tool-command-structured-exit',
          'No textual exit code here',
          '2026-06-27T08:01:03.000Z',
          { stdout: '', stderr: 'missing\n', exitCode: 2 },
        ),
      ],
      async transcriptPath => {
        const report = await buildTaskReport({
          transcriptPath,
          git: async () => gitMetadata({ dirty: false, changedFiles: [] }),
        })

        expect(report.commands).toEqual([
          expect.objectContaining({
            toolUseId: 'tool-command-structured-exit',
            status: 'error',
            exitCode: 2,
          }),
        ])
      },
    )
  })

  test('reports backgrounded validation commands with unknown status', async () => {
    await withTempTranscript(
      [
        userMessage(
          '00000000-0000-4000-8000-000000000048',
          'Run tests in the background.',
          '2026-06-27T08:00:00.000Z',
        ),
        assistantToolMessage(
          '00000000-0000-4000-8000-000000000049',
          {
            id: 'tool-background-validation',
            name: 'Bash',
            input: {
              command: 'bun test src/utils/reportTask.test.ts',
              run_in_background: true,
            },
          },
          '2026-06-27T08:01:00.000Z',
        ),
        toolResultMessage(
          '00000000-0000-4000-8000-000000000050',
          'tool-background-validation',
          'Command running in background with ID: bg-report-tests.',
          '2026-06-27T08:01:03.000Z',
          {
            stdout: '',
            stderr: '',
            interrupted: false,
            backgroundTaskId: 'bg-report-tests',
          },
        ),
      ],
      async transcriptPath => {
        const report = await buildTaskReport({
          transcriptPath,
          git: async () => gitMetadata({ dirty: false, changedFiles: [] }),
        })

        expect(report.commands).toEqual([
          expect.objectContaining({
            toolUseId: 'tool-background-validation',
            command: 'bun test src/utils/reportTask.test.ts',
            status: 'unknown',
          }),
        ])
        expect(report.validations).toEqual([
          expect.objectContaining({
            toolUseId: 'tool-background-validation',
            command: 'bun test src/utils/reportTask.test.ts',
            status: 'unknown',
          }),
        ])
        expect(report.warnings).not.toContain(
          'No validation commands were observed in this transcript.',
        )
      },
    )
  })

  test('reconciles completed backgrounded validation notifications', async () => {
    await withTempTranscript(
      [
        userMessage(
          '00000000-0000-4000-8000-000000000084',
          'Run tests in the background.',
          '2026-06-27T08:00:00.000Z',
        ),
        assistantToolMessage(
          '00000000-0000-4000-8000-000000000085',
          {
            id: 'tool-background-validation-complete',
            name: 'Bash',
            input: {
              command: 'bun test src/utils/reportTask.test.ts',
              run_in_background: true,
            },
          },
          '2026-06-27T08:01:00.000Z',
        ),
        toolResultMessage(
          '00000000-0000-4000-8000-000000000086',
          'tool-background-validation-complete',
          'Command running in background with ID: bg-report-tests.',
          '2026-06-27T08:01:03.000Z',
          {
            stdout: '',
            stderr: '',
            interrupted: false,
            backgroundTaskId: 'bg-report-tests',
          },
        ),
        userMessage(
          '00000000-0000-4000-8000-000000000087',
          [
            {
              type: 'text',
              text: `<task-notification>
<task-id>bg-report-tests</task-id>
<tool-use-id>tool-background-validation-complete</tool-use-id>
<output-file>/tmp/bg-report-tests.txt</output-file>
<status>completed</status>
<summary>Background command "bun test src/utils/reportTask.test.ts" completed (exit code 0)</summary>
</task-notification>`,
            },
          ],
          '2026-06-27T08:02:03.000Z',
        ),
      ],
      async transcriptPath => {
        const report = await buildTaskReport({
          transcriptPath,
          git: async () => gitMetadata({ dirty: false, changedFiles: [] }),
        })

        expect(report.toolUses).toEqual([
          expect.objectContaining({
            id: 'tool-background-validation-complete',
            status: 'success',
          }),
        ])
        expect(report.validations).toEqual([
          expect.objectContaining({
            toolUseId: 'tool-background-validation-complete',
            command: 'bun test src/utils/reportTask.test.ts',
            status: 'success',
          }),
        ])
      },
    )
  })

  test('reconciles failed backgrounded validation notifications', async () => {
    await withTempTranscript(
      [
        userMessage(
          '00000000-0000-4000-8000-000000000088',
          'Run checks in the background.',
          '2026-06-27T08:00:00.000Z',
        ),
        assistantToolMessage(
          '00000000-0000-4000-8000-000000000089',
          {
            id: 'tool-background-validation-fail',
            name: 'PowerShell',
            input: {
              command: 'bun run typecheck',
              run_in_background: true,
            },
          },
          '2026-06-27T08:01:00.000Z',
        ),
        toolResultMessage(
          '00000000-0000-4000-8000-000000000090',
          'tool-background-validation-fail',
          'Command running in background with ID: bg-typecheck.',
          '2026-06-27T08:01:03.000Z',
          {
            stdout: '',
            stderr: '',
            interrupted: false,
            backgroundTaskId: 'bg-typecheck',
          },
        ),
        userMessage(
          '00000000-0000-4000-8000-000000000091',
          `<task-notification>
<task-id>bg-typecheck</task-id>
<tool-use-id>tool-background-validation-fail</tool-use-id>
<output-file>/tmp/bg-typecheck.txt</output-file>
<status>failed</status>
<summary>Background command "bun run typecheck" failed with exit code 2</summary>
</task-notification>`,
          '2026-06-27T08:02:03.000Z',
        ),
      ],
      async transcriptPath => {
        const report = await buildTaskReport({
          transcriptPath,
          git: async () => gitMetadata({ dirty: false, changedFiles: [] }),
        })

        expect(report.toolUses).toEqual([
          expect.objectContaining({
            id: 'tool-background-validation-fail',
            status: 'error',
          }),
        ])
        expect(report.validations).toEqual([
          expect.objectContaining({
            toolUseId: 'tool-background-validation-fail',
            command: 'bun run typecheck',
            status: 'error',
          }),
        ])
      },
    )
  })

  test('does not let task notifications override resolved foreground shell results', async () => {
    await withTempTranscript(
      [
        userMessage(
          '00000000-0000-4000-8000-000000000092',
          'Run a foreground validation command.',
          '2026-06-27T08:00:00.000Z',
        ),
        assistantToolMessage(
          '00000000-0000-4000-8000-000000000093',
          {
            id: 'tool-foreground-validation-conflict',
            name: 'Bash',
            input: {
              command: 'bun test src/utils/reportTask.test.ts',
            },
          },
          '2026-06-27T08:01:00.000Z',
        ),
        toolResultMessage(
          '00000000-0000-4000-8000-000000000094',
          'tool-foreground-validation-conflict',
          'Command failed with exit code 2.',
          '2026-06-27T08:01:03.000Z',
          {
            stdout: '',
            stderr: 'failure',
            interrupted: false,
            exitCode: 2,
          },
        ),
        userMessage(
          '00000000-0000-4000-8000-000000000095',
          `<task-notification>
<task-id>unrelated-stale-task</task-id>
<tool-use-id>tool-foreground-validation-conflict</tool-use-id>
<output-file>/tmp/unrelated-stale-task.txt</output-file>
<status>completed</status>
<summary>Background command "bun test src/utils/reportTask.test.ts" completed (exit code 0)</summary>
</task-notification>`,
          '2026-06-27T08:02:03.000Z',
        ),
      ],
      async transcriptPath => {
        const report = await buildTaskReport({
          transcriptPath,
          git: async () => gitMetadata({ dirty: false, changedFiles: [] }),
        })

        expect(report.toolUses).toEqual([
          expect.objectContaining({
            id: 'tool-foreground-validation-conflict',
            status: 'error',
          }),
        ])
        expect(report.commands).toEqual([
          expect.objectContaining({
            toolUseId: 'tool-foreground-validation-conflict',
            command: 'bun test src/utils/reportTask.test.ts',
            status: 'error',
            exitCode: 2,
          }),
        ])
        expect(report.validations).toEqual([
          expect.objectContaining({
            toolUseId: 'tool-foreground-validation-conflict',
            command: 'bun test src/utils/reportTask.test.ts',
            status: 'error',
            exitCode: 2,
          }),
        ])
      },
    )
  })

  test('classifies validation commands from the raw Bash command before truncation', async () => {
    const longPrefix = 'echo setup && '.repeat(20)
    const rawCommand = `${longPrefix}bun test src/utils/reportTask.test.ts`

    await withTempTranscript(
      [
        userMessage(
          '00000000-0000-4000-8000-000000000019',
          'Run the long validation command.',
          '2026-06-27T08:00:00.000Z',
        ),
        assistantToolMessage(
          '00000000-0000-4000-8000-000000000020',
          {
            id: 'tool-validation-long',
            name: 'Bash',
            input: {
              command: rawCommand,
            },
          },
          '2026-06-27T08:01:00.000Z',
        ),
        toolResultMessage(
          '00000000-0000-4000-8000-000000000021',
          'tool-validation-long',
          'tests passed',
          '2026-06-27T08:01:03.000Z',
          { stdout: 'tests passed\n', stderr: '', interrupted: false },
        ),
      ],
      async transcriptPath => {
        const report = await buildTaskReport({
          transcriptPath,
          git: async () => gitMetadata({ dirty: false, changedFiles: [] }),
          maxPreviewChars: 32,
        })

        expect(report.commands[0]?.command).not.toContain('bun test')
        expect(report.validations).toEqual([
          expect.objectContaining({
            toolUseId: 'tool-validation-long',
            status: 'success',
          }),
        ])
        expect(report.warnings).not.toContain(
          'No validation commands were observed in this transcript.',
        )
      },
    )
  })

  test('classifies validation commands inside quoted shell wrappers', async () => {
    const commands = [
      "bash -lc 'bun run check'",
      'powershell -NoProfile -Command "bun run typecheck"',
    ]

    for (const [index, command] of commands.entries()) {
      await withTempTranscript(
        [
          userMessage(
            `00000000-0000-4000-8000-${String(78 + index * 3).padStart(12, '0')}`,
            `Run ${command}.`,
            '2026-06-27T08:00:00.000Z',
          ),
          assistantToolMessage(
            `00000000-0000-4000-8000-${String(79 + index * 3).padStart(12, '0')}`,
            {
              id: `tool-wrapper-validation-${index}`,
              name: 'Bash',
              input: {
                command,
              },
            },
            '2026-06-27T08:01:00.000Z',
          ),
          toolResultMessage(
            `00000000-0000-4000-8000-${String(80 + index * 3).padStart(12, '0')}`,
            `tool-wrapper-validation-${index}`,
            'passed',
            '2026-06-27T08:01:03.000Z',
            { stdout: 'passed\n', stderr: '', exitCode: 0 },
          ),
        ],
        async transcriptPath => {
          const report = await buildTaskReport({
            transcriptPath,
            git: async () => gitMetadata({ dirty: false, changedFiles: [] }),
          })

          expect(report.validations).toEqual([
            expect.objectContaining({
              command,
              status: 'success',
            }),
          ])
          expect(report.warnings).not.toContain(
            'No validation commands were observed in this transcript.',
          )
        },
      )
    }
  })

  test('classifies documented package checks as validations', async () => {
    const commands = [
      'bun run web:typecheck',
      'bun run web:build',
      'bun run integrations:check',
      'bun run verify:privacy',
      'bun run doctor:runtime',
      'bun run doctor:runtime:json',
      'bun run build:verified',
      'bun run hardening:check',
      'bun run hardening:strict',
    ]

    for (const [index, command] of commands.entries()) {
      await withTempTranscript(
        [
          userMessage(
            `00000000-0000-4000-8000-${String(51 + index * 3).padStart(12, '0')}`,
            `Run ${command}.`,
            '2026-06-27T08:00:00.000Z',
          ),
          assistantToolMessage(
            `00000000-0000-4000-8000-${String(52 + index * 3).padStart(12, '0')}`,
            {
              id: `tool-${command.replaceAll(/[^A-Za-z0-9]/g, '-')}`,
              name: 'Bash',
              input: {
                command,
              },
            },
            '2026-06-27T08:01:00.000Z',
          ),
          toolResultMessage(
            `00000000-0000-4000-8000-${String(53 + index * 3).padStart(12, '0')}`,
            `tool-${command.replaceAll(/[^A-Za-z0-9]/g, '-')}`,
            'passed',
            '2026-06-27T08:01:03.000Z',
            { stdout: 'passed\n', stderr: '', exitCode: 0 },
          ),
        ],
        async transcriptPath => {
          const report = await buildTaskReport({
            transcriptPath,
            git: async () => gitMetadata({ dirty: false, changedFiles: [] }),
          })

          expect(report.validations).toEqual([
            expect.objectContaining({
              command,
              status: 'success',
            }),
          ])
          expect(report.warnings).not.toContain(
            'No validation commands were observed in this transcript.',
          )
        },
      )
    }
  })

  test('captures file changes and branch metadata when available', async () => {
    await withTempTranscript(
      [
        {
          type: 'custom-title',
          sessionId,
          customTitle: 'Generate deterministic task reports',
        },
        {
          type: 'worktree-state',
          sessionId,
          worktreeSession: {
            originalCwd: cwd,
            worktreePath: '/workspace/openclaude-report',
            worktreeName: 'openclaude-report',
            worktreeBranch: 'feat/session-task-report-json',
            originalBranch: 'main',
            originalHeadCommit: '13cf30af',
            sessionId,
          },
        },
        {
          type: 'pr-link',
          sessionId,
          prNumber: 456,
          prUrl: 'https://github.com/Twigpine/openclaude/pull/456',
          prRepository: 'Twigpine/openclaude',
          timestamp: '2026-06-27T08:01:00.000Z',
        },
        userMessage(
          '00000000-0000-4000-8000-000000000008',
          'Update src/report.ts for https://github.com/Twigpine/openclaude/issues/123.',
          '2026-06-27T08:00:00.000Z',
        ),
        assistantToolMessage(
          '00000000-0000-4000-8000-000000000009',
          {
            id: 'tool-edit',
            name: 'Edit',
            input: {
              file_path: `${cwd}/src/report.ts`,
              old_string: 'old',
              new_string: 'new',
            },
          },
          '2026-06-27T08:02:00.000Z',
        ),
        toolResultMessage(
          '00000000-0000-4000-8000-000000000010',
          'tool-edit',
          'Updated src/report.ts',
          '2026-06-27T08:02:02.000Z',
          { filePath: `${cwd}/src/report.ts` },
        ),
      ],
      async transcriptPath => {
        const report = await buildTaskReport({
          transcriptPath,
          git: async () =>
            gitMetadata({
              changedFiles: ['src/report.ts', 'src/report.test.ts'],
            }),
        })

        expect(report.session.name).toBe('Generate deterministic task reports')
        expect(report.branch.transcriptBranch).toBe('feat/source-branch')
        expect(report.branch.worktree).toEqual(
          expect.objectContaining({
            branch: 'feat/session-task-report-json',
            originalBranch: 'main',
            originalHead: '13cf30af',
          }),
        )
        expect(report.branch.pullRequest).toEqual({
          number: 456,
          repository: 'Twigpine/openclaude',
          url: 'https://github.com/Twigpine/openclaude/pull/456',
        })
        expect(report.git).toEqual(
          expect.objectContaining({
            status: 'available',
            branch: 'feat/session-task-report-json',
            head: '13cf30af',
            dirty: true,
            changedFiles: ['src/report.test.ts', 'src/report.ts'],
          }),
        )
        expect(report.changedFiles).toEqual([
          { path: 'src/report.test.ts', sources: ['git'] },
          { path: 'src/report.ts', sources: ['git', 'tool'] },
        ])
        expect(report.linkedReferences).toEqual([
          {
            kind: 'issue',
            number: 123,
            repository: 'Twigpine/openclaude',
            url: 'https://github.com/Twigpine/openclaude/issues/123',
          },
          {
            kind: 'pull_request',
            number: 456,
            repository: 'Twigpine/openclaude',
            url: 'https://github.com/Twigpine/openclaude/pull/456',
          },
        ])
      },
    )
  })

  test('normalizes in-repo paths whose relative path starts with dots', async () => {
    await withTempTranscript(
      [
        userMessage(
          '00000000-0000-4000-8000-000000000037',
          'Update a dot-prefixed fixture path.',
          '2026-06-27T08:00:00.000Z',
        ),
        assistantToolMessage(
          '00000000-0000-4000-8000-000000000038',
          {
            id: 'tool-dot-fixture',
            name: 'Edit',
            input: {
              file_path: `${cwd}/..fixtures/report.ts`,
              old_string: 'old',
              new_string: 'new',
            },
          },
          '2026-06-27T08:01:00.000Z',
        ),
        toolResultMessage(
          '00000000-0000-4000-8000-000000000039',
          'tool-dot-fixture',
          'Updated fixture',
          '2026-06-27T08:01:02.000Z',
        ),
      ],
      async transcriptPath => {
        const report = await buildTaskReport({
          transcriptPath,
          git: async () => gitMetadata({ dirty: false, changedFiles: [] }),
        })

        expect(report.changedFiles).toEqual([
          { path: '..fixtures/report.ts', sources: ['tool'] },
        ])
      },
    )
  })

  test('normalizes Windows-style tool paths before merging with git paths', async () => {
    const windowsCwd = 'C:\\workspace\\openclaude'

    await withTempTranscript(
      [
        {
          ...userMessage(
            '00000000-0000-4000-8000-000000000040',
            'Update Windows paths.',
            '2026-06-27T08:00:00.000Z',
          ),
          cwd: windowsCwd,
        },
        assistantToolMessage(
          '00000000-0000-4000-8000-000000000041',
          {
            id: 'tool-windows-path',
            name: 'Edit',
            input: {
              file_path: 'C:\\workspace\\openclaude\\src\\report.ts',
              old_string: 'old',
              new_string: 'new',
            },
          },
          '2026-06-27T08:01:00.000Z',
        ),
        toolResultMessage(
          '00000000-0000-4000-8000-000000000042',
          'tool-windows-path',
          'Updated report',
          '2026-06-27T08:01:02.000Z',
        ),
        assistantToolMessage(
          '00000000-0000-4000-8000-000000000043',
          {
            id: 'tool-windows-dot-path',
            name: 'Edit',
            input: {
              file_path: 'C:\\workspace\\openclaude\\..fixtures\\report.ts',
              old_string: 'old',
              new_string: 'new',
            },
          },
          '2026-06-27T08:02:00.000Z',
        ),
        toolResultMessage(
          '00000000-0000-4000-8000-000000000044',
          'tool-windows-dot-path',
          'Updated fixture',
          '2026-06-27T08:02:02.000Z',
        ),
      ],
      async transcriptPath => {
        const report = await buildTaskReport({
          transcriptPath,
          git: async () =>
            gitMetadata({
              cwd: windowsCwd,
              changedFiles: ['src/report.ts'],
            }),
        })

        expect(report.changedFiles).toEqual([
          { path: '..fixtures/report.ts', sources: ['tool'] },
          { path: 'src/report.ts', sources: ['git', 'tool'] },
        ])
      },
    )
  })

  test('prefers transcript cwd over caller cwd for git metadata', async () => {
    const callerCwd = '/workspace/different-project'
    const observedGitCwds: string[] = []

    await withTempTranscript(
      [
        userMessage(
          '00000000-0000-4000-8000-000000000015',
          'Report the session.',
          '2026-06-27T08:00:00.000Z',
        ),
      ],
      async transcriptPath => {
        const report = await buildTaskReport({
          transcriptPath,
          cwd: callerCwd,
          git: async gitCwd => {
            observedGitCwds.push(gitCwd)
            return gitMetadata({
              cwd: gitCwd,
              branch: 'feat/session-cwd',
              dirty: false,
              changedFiles: [],
            })
          },
        })

        expect(observedGitCwds).toEqual([cwd])
        expect(report.git).toEqual(
          expect.objectContaining({
            cwd,
            branch: 'feat/session-cwd',
            dirty: false,
          }),
        )
      },
    )
  })

  test('does not serialize file read result content in tool summaries', async () => {
    const fileBody = 'PRIVATE_FILE_BODY_SHOULD_NOT_APPEAR'

    await withTempTranscript(
      [
        userMessage(
          '00000000-0000-4000-8000-000000000016',
          'Inspect a file.',
          '2026-06-27T08:00:00.000Z',
        ),
        assistantToolMessage(
          '00000000-0000-4000-8000-000000000017',
          {
            id: 'tool-read',
            name: 'Read',
            input: {
              file_path: 'src/secret.ts',
            },
          },
          '2026-06-27T08:01:00.000Z',
        ),
        toolResultMessage(
          '00000000-0000-4000-8000-000000000018',
          'tool-read',
          fileBody,
          '2026-06-27T08:01:01.000Z',
          { filePath: 'src/secret.ts', content: fileBody },
        ),
      ],
      async transcriptPath => {
        const report = await buildTaskReport({
          transcriptPath,
          git: async () => gitMetadata({ dirty: false, changedFiles: [] }),
        })
        const serialized = formatTaskReportAsJson(report)

        expect(serialized).not.toContain(fileBody)
        expect(report.toolUses).toEqual([
          expect.objectContaining({
            id: 'tool-read',
            name: 'Read',
            files: ['src/secret.ts'],
          }),
        ])
        expect(report.toolUses[0]).not.toHaveProperty('resultSummary')
      },
    )
  })

  test('does not collect linked references from tool result content', async () => {
    await withTempTranscript(
      [
        userMessage(
          '00000000-0000-4000-8000-000000000022',
          'Summarize the session.',
          '2026-06-27T08:00:00.000Z',
        ),
        toolResultMessage(
          '00000000-0000-4000-8000-000000000023',
          'tool-read',
          'File body mentions https://github.com/Twigpine/openclaude/issues/999.',
          '2026-06-27T08:01:01.000Z',
        ),
      ],
      async transcriptPath => {
        const report = await buildTaskReport({
          transcriptPath,
          git: async () => gitMetadata({ dirty: false, changedFiles: [] }),
        })

        expect(report.linkedReferences).toEqual([])
      },
    )
  })

  test('redacts credential-shaped strings and truncates large outputs deterministically', async () => {
    const secret = 'sk-ant-secret-token'
    const longOutput = `${'x'.repeat(200)} ${secret}`

    await withTempTranscript(
      [
        userMessage(
          '00000000-0000-4000-8000-000000000011',
          `Please use token ghp_1234567890abcdef to test redaction.`,
          '2026-06-27T08:00:00.000Z',
        ),
        assistantToolMessage(
          '00000000-0000-4000-8000-000000000012',
          {
            id: 'tool-secret',
            name: 'Bash',
            input: {
              command: `curl -H "Authorization: Bearer ${secret}" https://example.test`,
            },
          },
          '2026-06-27T08:01:00.000Z',
        ),
        toolResultMessage(
          '00000000-0000-4000-8000-000000000013',
          'tool-secret',
          longOutput,
          '2026-06-27T08:01:01.000Z',
          { stdout: longOutput, stderr: '', interrupted: false },
        ),
      ],
      async transcriptPath => {
        const report = await buildTaskReport({
          transcriptPath,
          git: async () => gitMetadata({ dirty: false, changedFiles: [] }),
          maxPreviewChars: 64,
        })
        const serialized = formatTaskReportAsJson(report)

        expect(report.redaction).toEqual({
          mode: 'best_effort',
          maxPreviewChars: 64,
        })
        expect(serialized).toBe(formatTaskReportAsJson(report))
        expect(serialized.endsWith('\n')).toBe(false)
        expect(serialized).not.toContain(secret)
        expect(serialized).not.toContain('ghp_1234567890abcdef')
        expect(serialized).toContain('[REDACTED]')
        expect(report.commands[0]?.stdout?.preview.length).toBeLessThanOrEqual(
          64,
        )
        expect(report.commands[0]?.stdout?.truncated).toBe(true)
      },
    )
  })

  test('formats markdown with required sections and no-validation warning', async () => {
    await withTempTranscript(
      [
        userMessage(
          '00000000-0000-4000-8000-000000000096',
          'Generate a task report for issue #123.',
          '2026-06-27T08:00:00.000Z',
        ),
      ],
      async transcriptPath => {
        const report = await buildTaskReport({
          transcriptPath,
          git: async () => gitMetadata({ dirty: false, changedFiles: [] }),
        })
        const markdown = formatTaskReportAsMarkdown(report)

        for (const heading of [
          '# Task Report',
          '## Summary',
          '## Session',
          '## Branching / Worktree',
          '## Changes',
          '## Files changed',
          '## Commands run',
          '## Validation',
          '## Errors / Warnings',
          '## Risks / Follow-ups',
        ]) {
          expect(markdown).toContain(heading)
        }
        expect(markdown).toContain('- Validation: none observed')
        expect(markdown).toContain(
          '- Initial request:\n  ```text\n  Generate a task report for issue #123.\n  ```',
        )
        expect(markdown).toContain(
          '- No validation commands were observed in this transcript.',
        )
        expect(markdown).toContain(
          '- Not represented in task report JSON v1.',
        )
        expect(markdown).not.toContain('Run validation before claiming checks passed')
      },
    )
  })

  test('formats markdown for passing validation commands', async () => {
    await withTempTranscript(
      [
        userMessage(
          '00000000-0000-4000-8000-000000000097',
          'Run the checks.',
          '2026-06-27T08:00:00.000Z',
        ),
        assistantToolMessage(
          '00000000-0000-4000-8000-000000000098',
          {
            id: 'tool-validation-markdown-pass',
            name: 'Bash',
            input: {
              command: 'bun run typecheck',
              description: 'Run TypeScript checks',
            },
          },
          '2026-06-27T08:01:00.000Z',
        ),
        toolResultMessage(
          '00000000-0000-4000-8000-000000000099',
          'tool-validation-markdown-pass',
          'Typecheck passed',
          '2026-06-27T08:01:03.000Z',
          { stdout: 'Typecheck passed\n', stderr: '', exitCode: 0 },
        ),
      ],
      async transcriptPath => {
        const report = await buildTaskReport({
          transcriptPath,
          git: async () => gitMetadata({ dirty: false, changedFiles: [] }),
        })
        const markdown = formatTaskReportAsMarkdown(report)

        expect(markdown).toContain('- Validation: 1 passed, 0 failed, 0 unknown')
        expect(markdown).toContain(
          '- `success` `bun run typecheck` - Run TypeScript checks (exit 0)',
        )
        expect(markdown).toContain(
          '  - stdout:\n    ```text\n    Typecheck passed\n    \n    ```',
        )
        expect(markdown).toContain('- Not represented in task report JSON v1.')
      },
    )
  })

  test('formats markdown for failing validation and tool errors', async () => {
    await withTempTranscript(
      [
        userMessage(
          '00000000-0000-4000-8000-000000000100',
          'Run the failing test.',
          '2026-06-27T08:00:00.000Z',
        ),
        assistantToolMessage(
          '00000000-0000-4000-8000-000000000101',
          {
            id: 'tool-validation-markdown-fail',
            name: 'Bash',
            input: {
              command: 'bun test src/utils/reportTask.test.ts',
            },
          },
          '2026-06-27T08:01:00.000Z',
        ),
        toolResultMessage(
          '00000000-0000-4000-8000-000000000102',
          'tool-validation-markdown-fail',
          'Error calling tool (Bash): tests failed\nExit code 1',
          '2026-06-27T08:01:03.000Z',
          {
            stdout: '',
            stderr: 'tests failed\n',
            exitCode: 1,
          },
          true,
        ),
      ],
      async transcriptPath => {
        const report = await buildTaskReport({
          transcriptPath,
          git: async () => gitMetadata({ dirty: false, changedFiles: [] }),
        })
        const markdown = formatTaskReportAsMarkdown(report)

        expect(markdown).toContain('- Validation: 0 passed, 1 failed, 0 unknown')
        expect(markdown).toContain(
          '- `error` `bun test src/utils/reportTask.test.ts` (exit 1)',
        )
        expect(markdown).toContain(
          '- Tool error (`Bash`, `tool-validation-markdown-fail`):',
        )
        expect(markdown).not.toContain('Resolve failed validation')
        expect(markdown).toContain('- Not represented in task report JSON v1.')
      },
    )
  })

  test('rejects unsupported task report formats', async () => {
    await withTempTranscript(
      [
        userMessage(
          '00000000-0000-4000-8000-000000000109',
          'Generate a task report.',
          '2026-06-27T08:00:00.000Z',
        ),
      ],
      async transcriptPath => {
        const report = await buildTaskReport({
          transcriptPath,
          git: false,
        })

        expect(() => formatTaskReport(report, 'html' as never)).toThrow(
          'Unsupported task report format: html',
        )
      },
    )
  })

  test('preserves trailing whitespace in markdown command output previews', async () => {
    await withTempTranscript(
      [
        userMessage(
          '00000000-0000-4000-8000-000000000110',
          'Run a command with whitespace-sensitive output.',
          '2026-06-27T08:00:00.000Z',
        ),
        assistantToolMessage(
          '00000000-0000-4000-8000-000000000111',
          {
            id: 'tool-whitespace-preview',
            name: 'Bash',
            input: {
              command: 'bun test src/utils/reportTask.test.ts',
            },
          },
          '2026-06-27T08:01:00.000Z',
        ),
        toolResultMessage(
          '00000000-0000-4000-8000-000000000112',
          'tool-whitespace-preview',
          'kept trailing whitespace  \n',
          '2026-06-27T08:01:03.000Z',
          {
            stdout: 'kept trailing whitespace  \n',
            stderr: '',
            exitCode: 0,
          },
        ),
      ],
      async transcriptPath => {
        const report = await buildTaskReport({
          transcriptPath,
          git: false,
        })
        const markdown = formatTaskReportAsMarkdown(report)

        expect(markdown).toContain(
          '  - stdout:\n    ```text\n    kept trailing whitespace  \n    \n    ```',
        )
      },
    )
  })

  test('preserves repeated spaces in markdown command lines', async () => {
    await withTempTranscript(
      [
        userMessage(
          '00000000-0000-4000-8000-000000000115',
          'Run a whitespace-sensitive command.',
          '2026-06-27T08:00:00.000Z',
        ),
        assistantToolMessage(
          '00000000-0000-4000-8000-000000000116',
          {
            id: 'tool-command-repeated-spaces',
            name: 'Bash',
            input: {
              command: "printf 'a  b'",
            },
          },
          '2026-06-27T08:01:00.000Z',
        ),
        toolResultMessage(
          '00000000-0000-4000-8000-000000000117',
          'tool-command-repeated-spaces',
          'a  b',
          '2026-06-27T08:01:03.000Z',
          { stdout: 'a  b', stderr: '', exitCode: 0 },
        ),
      ],
      async transcriptPath => {
        const report = await buildTaskReport({
          transcriptPath,
          git: false,
        })
        const markdown = formatTaskReportAsMarkdown(report)

        expect(markdown).toContain("- `success` `printf 'a  b'` (exit 0)")
        expect(markdown).not.toContain("- `success` `printf 'a b'`")
      },
    )
  })

  test('renders backtick-delimited markdown command spans safely', async () => {
    await withTempTranscript(
      [
        userMessage(
          '00000000-0000-4000-8000-000000000127',
          'Run a command that uses command substitution.',
          '2026-06-27T08:00:00.000Z',
        ),
        assistantToolMessage(
          '00000000-0000-4000-8000-000000000128',
          {
            id: 'tool-command-backticks',
            name: 'Bash',
            input: {
              command: 'echo `date`',
            },
          },
          '2026-06-27T08:01:00.000Z',
        ),
        toolResultMessage(
          '00000000-0000-4000-8000-000000000129',
          'tool-command-backticks',
          'Tue Jun 30',
          '2026-06-27T08:01:03.000Z',
          { stdout: 'Tue Jun 30', stderr: '', exitCode: 0 },
        ),
      ],
      async transcriptPath => {
        const report = await buildTaskReport({
          transcriptPath,
          git: false,
        })
        const markdown = formatTaskReportAsMarkdown(report)

        expect(markdown).toContain('- `success` `` echo `date` `` (exit 0)')
        expect(markdown).not.toContain('- `success` ``echo `date``` (exit 0)')
      },
    )
  })

  test('renders multiline markdown commands as fenced shell blocks', async () => {
    await withTempTranscript(
      [
        userMessage(
          '00000000-0000-4000-8000-000000000118',
          'Run a multiline command.',
          '2026-06-27T08:00:00.000Z',
        ),
        assistantToolMessage(
          '00000000-0000-4000-8000-000000000119',
          {
            id: 'tool-command-multiline',
            name: 'Bash',
            input: {
              command:
                "printf 'a  b'\nbun test src/utils/reportTask.test.ts",
            },
          },
          '2026-06-27T08:01:00.000Z',
        ),
        toolResultMessage(
          '00000000-0000-4000-8000-000000000120',
          'tool-command-multiline',
          'tests passed',
          '2026-06-27T08:01:03.000Z',
          { stdout: 'tests passed', stderr: '', exitCode: 0 },
        ),
      ],
      async transcriptPath => {
        const report = await buildTaskReport({
          transcriptPath,
          git: false,
        })
        const markdown = formatTaskReportAsMarkdown(report)

        expect(markdown).toContain(
          "- `success` command (exit 0)\n  - Command:\n    ```shell\n    printf 'a  b'\n    bun test src/utils/reportTask.test.ts\n    ```",
        )
      },
    )
  })

  test('escapes markdown syntax in markdown prose fields', async () => {
    await withTempTranscript(
      [
        {
          type: 'custom-title',
          sessionId,
          customTitle: 'Review *bold* [link](https://example.test)',
        },
        userMessage(
          '00000000-0000-4000-8000-000000000121',
          'Run a markdown-sensitive command.',
          '2026-06-27T08:00:00.000Z',
        ),
        assistantToolMessage(
          '00000000-0000-4000-8000-000000000122',
          {
            id: 'tool-markdown-prose',
            name: 'Bash',
            input: {
              command: 'node missing.js',
              description: 'Do *not* make [claims](x)',
            },
          },
          '2026-06-27T08:01:00.000Z',
        ),
        toolResultMessage(
          '00000000-0000-4000-8000-000000000123',
          'tool-markdown-prose',
          'Tool **failed** [details](x)',
          '2026-06-27T08:01:03.000Z',
          {
            stdout: '',
            stderr: 'Tool **failed** [details](x)',
            exitCode: 1,
          },
          true,
        ),
      ],
      async transcriptPath => {
        const report = await buildTaskReport({
          transcriptPath,
          git: false,
        })
        report.warnings.push('Warning with *bold* and [link](x)')
        const markdown = formatTaskReportAsMarkdown(report)

        expect(markdown).toContain(
          '- Session: Review \\*bold\\* \\[link\\](https://example.test/)',
        )
        expect(markdown).toContain(
          '- Title: Review \\*bold\\* \\[link\\](https://example.test/)',
        )
        expect(markdown).toContain(
          '- `error` `node missing.js` - Do \\*not\\* make \\[claims\\](x) (exit 1)',
        )
        expect(markdown).toContain(
          '- Tool error (`Bash`, `tool-markdown-prose`): Tool \\*\\*failed\\*\\* \\[details\\](x)',
        )
        expect(markdown).toContain(
          '- Warning with \\*bold\\* and \\[link\\](x)',
        )
      },
    )
  })

  test('preserves multiline errors and warnings in markdown', async () => {
    await withTempTranscript(
      [
        userMessage(
          '00000000-0000-4000-8000-000000000124',
          'Run a command that reports multiline diagnostics.',
          '2026-06-27T08:00:00.000Z',
        ),
        assistantToolMessage(
          '00000000-0000-4000-8000-000000000125',
          {
            id: 'tool-multiline-diagnostic',
            name: 'Bash',
            input: {
              command: 'node missing.js',
            },
          },
          '2026-06-27T08:01:00.000Z',
        ),
        toolResultMessage(
          '00000000-0000-4000-8000-000000000126',
          'tool-multiline-diagnostic',
          'first error line\nsecond error line',
          '2026-06-27T08:01:03.000Z',
          {
            stdout: '',
            stderr: 'first error line\nsecond error line',
            exitCode: 1,
          },
          true,
        ),
      ],
      async transcriptPath => {
        const report = await buildTaskReport({
          transcriptPath,
          git: false,
        })
        report.warnings.push('first warning line\nsecond warning line')
        const markdown = formatTaskReportAsMarkdown(report)

        expect(markdown).toContain(
          '- Tool error (`Bash`, `tool-multiline-diagnostic`):\n  ```text\n  first error line\n  second error line\n  ```',
        )
        expect(markdown).toContain(
          '- Warning:\n  ```text\n  first warning line\n  second warning line\n  ```',
        )
        expect(markdown).not.toContain('first error line second error line')
        expect(markdown).not.toContain('first warning line second warning line')
      },
    )
  })

  test('formats markdown for changed files and branch metadata', async () => {
    const reportCwd = join(tmpdir(), 'openclaude')
    const worktreePath = join(tmpdir(), 'openclaude-report')
    const reportFilePath = join(reportCwd, 'src', 'report.ts')
    const reportSourcePath = posix.join('src', 'report.ts')
    const reportTestPath = posix.join('src', 'report.test.ts')

    await withTempTranscript(
      [
        {
          type: 'custom-title',
          sessionId,
          customTitle: 'Generate deterministic task reports',
        },
        {
          type: 'worktree-state',
          sessionId,
          worktreeSession: {
            originalCwd: reportCwd,
            worktreePath,
            worktreeName: 'openclaude-report',
            worktreeBranch: 'feat/session-task-report-json',
            originalBranch: 'main',
            originalHeadCommit: '13cf30af',
            sessionId,
          },
        },
        {
          type: 'pr-link',
          sessionId,
          prNumber: 456,
          prUrl: 'https://github.com/Twigpine/openclaude/pull/456',
          prRepository: 'Twigpine/openclaude',
          timestamp: '2026-06-27T08:01:00.000Z',
        },
        userMessage(
          '00000000-0000-4000-8000-000000000103',
          'Update src/report.ts for https://github.com/Twigpine/openclaude/issues/123.',
          '2026-06-27T08:00:00.000Z',
          reportCwd,
        ),
        assistantToolMessage(
          '00000000-0000-4000-8000-000000000104',
          {
            id: 'tool-edit-markdown',
            name: 'Edit',
            input: {
              file_path: reportFilePath,
              old_string: 'old',
              new_string: 'new',
            },
          },
          '2026-06-27T08:02:00.000Z',
        ),
        toolResultMessage(
          '00000000-0000-4000-8000-000000000105',
          'tool-edit-markdown',
          'Updated src/report.ts',
          '2026-06-27T08:02:02.000Z',
          { filePath: reportFilePath },
        ),
      ],
      async transcriptPath => {
        const report = await buildTaskReport({
          transcriptPath,
          git: async () =>
            gitMetadata({
              cwd: reportCwd,
              changedFiles: [reportSourcePath, reportTestPath],
            }),
        })
        const markdown = formatTaskReportAsMarkdown(report)

        expect(markdown).toContain(
          '- Title: Generate deterministic task reports',
        )
        expect(markdown).toContain('- Transcript branch: `feat/source-branch`')
        expect(markdown).toContain(
          '- Worktree branch: `feat/session-task-report-json`',
        )
        expect(markdown).toContain(
          '- Pull request: [#456](<https://github.com/Twigpine/openclaude/pull/456>) (`Twigpine/openclaude`)',
        )
        expect(markdown).toContain(`- \`${reportSourcePath}\` (git, tool)`)
        expect(markdown).toContain(`- \`${reportTestPath}\` (git)`)
        expect(markdown).toContain(
          '- pull_request: [#456](<https://github.com/Twigpine/openclaude/pull/456>) (`Twigpine/openclaude`)',
        )
      },
    )
  })

  test('sanitizes linked reference markdown URLs', async () => {
    await withTempTranscript(
      [
        userMessage(
          '00000000-0000-4000-8000-000000000130',
          'Review linked references.',
          '2026-06-27T08:00:00.000Z',
        ),
      ],
      async transcriptPath => {
        const report = await buildTaskReport({
          transcriptPath,
          git: false,
        })
        report.linkedReferences = [
          {
            kind: 'issue',
            number: 321,
            repository: 'Twigpine/openclaude',
            url: 'https://github.com/Twigpine/openclaude/issues/321?label=a(b)',
          },
          {
            kind: 'pull_request',
            number: 9,
            url: 'javascript:alert(1)',
          },
        ]

        const markdown = formatTaskReportAsMarkdown(report)

        expect(markdown).toContain(
          '- issue: [#321](<https://github.com/Twigpine/openclaude/issues/321?label=a(b)>) (`Twigpine/openclaude`)',
        )
        expect(markdown).toContain('- pull_request: `#9`')
        expect(markdown).not.toContain('javascript:alert')
      },
    )
  })

  test('formats markdown with redacted secrets and truncated command output', async () => {
    const secret = 'sk-openclaude-test-secret'
    const longOutput = `${secret}\n${'passed '.repeat(40)}`

    await withTempTranscript(
      [
        userMessage(
          '00000000-0000-4000-8000-000000000106',
          `Check the output for ${secret}.`,
          '2026-06-27T08:00:00.000Z',
        ),
        assistantToolMessage(
          '00000000-0000-4000-8000-000000000107',
          {
            id: 'tool-validation-markdown-redacted',
            name: 'Bash',
            input: {
              command: `TOKEN=${secret} bun test src/utils/reportTask.test.ts`,
            },
          },
          '2026-06-27T08:01:00.000Z',
        ),
        toolResultMessage(
          '00000000-0000-4000-8000-000000000108',
          'tool-validation-markdown-redacted',
          longOutput,
          '2026-06-27T08:01:03.000Z',
          { stdout: longOutput, stderr: '', exitCode: 0 },
        ),
      ],
      async transcriptPath => {
        const report = await buildTaskReport({
          transcriptPath,
          git: async () => gitMetadata({ dirty: false, changedFiles: [] }),
          maxPreviewChars: 64,
        })
        const markdown = formatTaskReportAsMarkdown(report)

        expect(markdown).not.toContain(secret)
        expect(markdown).toMatch(/\[REDACTED(?:_OPENAI_KEY)?\]/)
        expect(markdown).toContain('stdout (truncated, ')
        expect(markdown).toContain('```text\n')
      },
    )
  })

  test('prints markdown task reports through the CLI handler', async () => {
    await withTempTranscript(
      [
        userMessage(
          '00000000-0000-4000-8000-000000000113',
          'Generate a markdown task report.',
          '2026-06-27T08:00:00.000Z',
          null,
        ),
      ],
      async transcriptPath => {
        const handlerCwd = dirname(transcriptPath)
        const stdout = await captureStreamWrites(process.stdout, async () => {
          await taskReportHandler({
            format: 'markdown',
            transcriptPath,
            sessionId: null,
            outFile: null,
            cwd: handlerCwd,
          })
        })

        expect(stdout).toContain('# Task Report')
        expect(stdout).toContain('## Validation')
        expect(stdout).toContain('- Git status: `unavailable`')
        expect(stdout).toContain('- No validation commands were observed.')
      },
    )
  })

  test('writes markdown task reports through the CLI handler', async () => {
    await withTempTranscript(
      [
        userMessage(
          '00000000-0000-4000-8000-000000000114',
          'Write a markdown task report.',
          '2026-06-27T08:00:00.000Z',
          null,
        ),
      ],
      async transcriptPath => {
        const handlerCwd = dirname(transcriptPath)
        const outFile = `${transcriptPath}.md`
        const stderr = await captureStreamWrites(process.stderr, async () => {
          await taskReportHandler({
            format: 'markdown',
            transcriptPath,
            sessionId: null,
            outFile,
            cwd: handlerCwd,
          })
        })

        expect(stderr).toBe(`Task report written to ${outFile}\n`)
        expect(readFileSync(outFile, 'utf8')).toContain('# Task Report')
      },
    )
  })

  test('parses markdown report options through the CLI command', async () => {
    const calls: Array<Parameters<typeof taskReportHandler>[0]> = []
    const exits: number[] = []
    const program = new CommanderCommand()
    program.exitOverride()
    registerTaskReportCommand(program, {
      cwd: () => '/repo',
      exit: code => {
        exits.push(code)
      },
      taskReportHandler: async options => {
        calls.push(options)
      },
      printTaskReportError: async error => {
        throw error
      },
    })

    await program.parseAsync(
      ['node', 'openclaude', 'report', '--markdown', '--transcript', 'session.jsonl'],
      { from: 'node' },
    )

    expect(calls).toEqual([
      {
        format: 'markdown',
        transcriptPath: 'session.jsonl',
        sessionId: null,
        outFile: null,
        cwd: '/repo',
      },
    ])
    expect(exits).toEqual([0])
  })

  test('parses json report options through the CLI command', async () => {
    const calls: Array<Parameters<typeof taskReportHandler>[0]> = []
    const exits: number[] = []
    const program = new CommanderCommand()
    program.exitOverride()
    registerTaskReportCommand(program, {
      cwd: () => '/repo',
      exit: code => {
        exits.push(code)
      },
      taskReportHandler: async options => {
        calls.push(options)
      },
      printTaskReportError: async error => {
        throw error
      },
    })

    await program.parseAsync(
      ['node', 'openclaude', 'report', '--json', '--session', sessionId, '--out', 'task-report.json'],
      { from: 'node' },
    )

    expect(calls).toEqual([
      {
        format: 'json',
        transcriptPath: null,
        sessionId,
        outFile: 'task-report.json',
        cwd: '/repo',
      },
    ])
    expect(exits).toEqual([0])
  })

  test('rejects missing and conflicting report output flags through the CLI command', async () => {
    const missingErrors: string[] = []
    const missingExits: number[] = []
    const missingProgram = new CommanderCommand()
    missingProgram.exitOverride()
    registerTaskReportCommand(missingProgram, {
      exit: code => {
        missingExits.push(code)
      },
      taskReportHandler: async () => {
        throw new Error('handler should not run')
      },
      printTaskReportError: async error => {
        missingErrors.push(error instanceof Error ? error.message : String(error))
      },
    })

    await missingProgram.parseAsync(['node', 'openclaude', 'report'], {
      from: 'node',
    })

    expect(missingErrors).toEqual([
      'Pass either --json or --markdown for task report output.',
    ])
    expect(missingExits).toEqual([1])

    const conflictingProgram = new CommanderCommand()
    conflictingProgram.exitOverride()
    conflictingProgram.configureOutput({ writeErr: () => {} })
    registerTaskReportCommand(conflictingProgram)

    await expect(
      conflictingProgram.parseAsync(
        ['node', 'openclaude', 'report', '--json', '--markdown'],
        { from: 'node' },
      ),
    ).rejects.toThrow("option '--json' cannot be used with option '--markdown'")
  })

  test('normalizes max preview chars in report metadata', async () => {
    await withTempTranscript(
      [
        userMessage(
          '00000000-0000-4000-8000-000000000024',
          'abcdef',
          '2026-06-27T08:00:00.000Z',
        ),
      ],
      async transcriptPath => {
        const report = await buildTaskReport({
          transcriptPath,
          git: false,
          maxPreviewChars: 0,
        })

        expect(report.redaction.maxPreviewChars).toBe(1)
        expect(report.session.initialRequest).toBe('a')
      },
    )
  })

  test('omits dirty status when git status cannot be collected', async () => {
    const repoDir = join(homedir(), 'openclaude-task-report-git-repo')
    const calls: string[] = []

    const metadata = await collectTaskReportGitMetadata(
      repoDir,
      async (gitCwd, args) => {
        expect(gitCwd).toBe(repoDir)
        const command = args.join(' ')
        calls.push(command)

        switch (command) {
          case '--no-optional-locks rev-parse --is-inside-work-tree':
            return { stdout: 'true', stderr: '', code: 0 }
          case '--no-optional-locks branch --show-current':
            return { stdout: 'feat/report', stderr: '', code: 0 }
          case '--no-optional-locks rev-parse --short=12 HEAD':
            return { stdout: '13cf30afa469', stderr: '', code: 0 }
          case '--no-optional-locks status --porcelain=v1':
            return { stdout: '', stderr: 'status failed', code: 1 }
          default:
            return {
              stdout: '',
              stderr: `unexpected command: ${command}`,
              code: 2,
            }
        }
      }
    )

    expect(calls).toEqual(
      expect.arrayContaining([
        '--no-optional-locks rev-parse --is-inside-work-tree',
        '--no-optional-locks branch --show-current',
        '--no-optional-locks rev-parse --short=12 HEAD',
        '--no-optional-locks status --porcelain=v1',
      ]),
    )
    expect(metadata).toEqual({
      status: 'available',
      cwd: join('~', 'openclaude-task-report-git-repo'),
      branch: 'feat/report',
      head: '13cf30afa469',
      changedFiles: [],
      error: 'status failed',
    })
    expect(metadata).not.toHaveProperty('dirty')
  })

  test('degrades gracefully for malformed and old transcripts', async () => {
    await withTempTranscript(
      [
        '{not valid json',
        {
          type: 'summary',
          leafUuid: '00000000-0000-4000-8000-000000000014',
          summary: 'old transcript metadata',
        },
      ],
      async transcriptPath => {
        const report = await buildTaskReport({
          transcriptPath,
          git: async () => ({
            status: 'unavailable',
            cwd,
            changedFiles: [],
            error: 'not a git repository',
          }),
        })

        expect(report.session.id).toBe(sessionId)
        expect(report.toolUses).toEqual([])
        expect(report.commands).toEqual([])
        expect(report.warnings).toContain(
          'Skipped 1 malformed transcript line.',
        )
        expect(report.warnings).toContain(
          'No validation commands were observed in this transcript.',
        )
      },
    )
  })
})
