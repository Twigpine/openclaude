import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getWindowsBashHookCommand } from './windowsBashCommand.js'

describe('Windows bash hook commands', () => {
  test.each([
    'if [ -f ./hook.sh ]; then bash ./hook.sh; fi',
    'for script in ./hook.sh; do bash "$script"; done',
    'while false; do ./hook.sh; done',
    'case "$file" in *.sh) echo shell;; esac',
    '(bash ./hook.sh)',
    '{ bash ./hook.sh; }',
    'echo ./hook.sh',
    'echo ./hook.SH',
    'node ./hook.SH.js',
    'echo "./hook.sh"',
    'bash ./hook.sh',
    'bash\t./hook.sh',
    'sh ./hook.sh',
    '/usr/bin/bash ./hook.sh',
    'env bash ./hook.sh',
    'SCRIPT=./hook.sh bash "$SCRIPT"',
    'FOO="a b" BAR=./hook.sh bash ./hook.sh',
    'FOO=./hook.sh',
    'FOO=bar; ./hook.sh',
    'FOO=bar\n./hook.sh',
    'FOO=bar # ./hook.sh',
    'FOO=${FOO:-bash ./hook.sh --flag} /bin/sh -c \'printf "%s\\n" "$FOO"\'',
    'node ./hook.sh.js',
    './hook.sh.backup',
    'printf "ready\\n"\n./hook.sh',
    '"${HOOK_COMMAND:-./hook.sh}" OK',
    '${HOOK_SCRIPT%.sh}',
    '#hook.sh',
    'hook.sh() { printf done; }',
    'hook.sh () { printf done; }',
  ])('preserves shell command: %s', command => {
    expect(getWindowsBashHookCommand(command)).toBe(command)
  })

  test.each([
    './hook.sh',
    './hook.sh argument',
    '  /c/work/hooks/hook.sh --check',
    '"/c/Program Files/hooks/hook.sh" argument',
    "'/c/Program Files/hooks/hook.sh' argument",
    '"$CLAUDE_PROJECT_DIR/hooks/hook.sh"',
    '${CLAUDE_PROJECT_DIR}/hooks/hook.sh',
    './hooks/my\\ hook.sh argument',
    '"./hooks/my hook".sh argument',
    './hook.sh && printf done',
    './hook.sh; printf done',
    './C#/hooks/hook.sh',
    './hook.SH',
    './hook.Sh argument',
    '"/c/Program Files/hooks/HOOK.SH" argument',
  ])('runs a directly invoked script with bash: %s', command => {
    expect(getWindowsBashHookCommand(command)).toBe(`bash ${command}`)
  })

  test.each([
    ['FOO=bar ./hook.sh', 'FOO=bar bash ./hook.sh'],
    [
      'FOO="a b" BAR=\'c d\' "./hook script.sh" argument',
      'FOO="a b" BAR=\'c d\' bash "./hook script.sh" argument',
    ],
    ['FOO=bar \\\n ./hook.sh', 'FOO=bar \\\n bash ./hook.sh'],
  ])('preserves assignments before a direct script: %s', (command, expected) => {
    expect(getWindowsBashHookCommand(command)).toBe(expected)
  })

  test.skipIf(process.platform === 'win32')(
    'passes quoted environment assignments to a non-executable script',
    async () => {
      const directory = await mkdtemp(join(tmpdir(), 'openclaude-hook-env-'))
      try {
        await writeFile(join(directory, 'hook script.sh'), 'printf "%s|%s\\n" "$FOO" "$BAR"\n', {
          mode: 0o600,
        })
        for (const command of [
          'FOO="a b" BAR=\'c d\' "./hook script.sh"',
          'FOO="a b" \\\n BAR=\'c d\' "./hook script.sh"',
        ]) {
          const child = Bun.spawn(['bash', '-c', getWindowsBashHookCommand(command)], {
            cwd: directory,
            stdout: 'pipe',
            stderr: 'pipe',
          })
          const [status, stdout, stderr] = await Promise.all([
            child.exited,
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
          ])
          expect({ command, status, stdout, stderr }).toEqual({
            command,
            status: 0,
            stdout: 'a b|c d\n',
            stderr: '',
          })
        }
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    },
  )

  test.skipIf(process.platform === 'win32')(
    'does not insert an interpreter inside expanded assignment values',
    async () => {
      for (const value of [
        '${FOO:-bash ./hook.sh --flag}',
        '"${FOO:-"bash ./hook.sh --flag"}"',
        '"$(printf "%s" "bash ./hook.sh --flag")"',
      ]) {
        const command = `FOO=${value} /bin/sh -c 'printf "%s\\n" "$FOO"'`
        const child = Bun.spawn(['bash', '-c', getWindowsBashHookCommand(command)], {
          env: { ...process.env, FOO: '' },
          stdout: 'pipe',
          stderr: 'pipe',
        })
        const [status, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ])
        expect({ value, status, stdout, stderr }).toEqual({
          value,
          status: 0,
          stdout: 'bash ./hook.sh --flag\n',
          stderr: '',
        })
      }
    },
  )

  test.skipIf(process.platform === 'win32')(
    'executes compound hooks and non-executable script paths with real bash',
    async () => {
      const directory = await mkdtemp(join(tmpdir(), 'openclaude-hook-command-'))
      try {
        await writeFile(join(directory, 'hook script.sh'), 'printf "{}\\n"\n', {
          mode: 0o600,
        })
        await writeFile(join(directory, 'C# hook.sh'), 'printf "{}\\n"\n', {
          mode: 0o600,
        })
        for (const command of [
          'if [ -f "./hook script.sh" ]; then bash "./hook script.sh"; else printf "missing\\n"; fi',
          '"./hook script.sh"',
          "'./hook script.sh'",
          './hook\\ script.sh',
          'bash "./hook script.sh"',
          './C#\\ hook.sh',
          '"${HOOK_COMMAND:-./hook.sh}" "{}"',
        ]) {
          const child = Bun.spawn(['bash', '-c', getWindowsBashHookCommand(command)], {
            cwd: directory,
            env: { ...process.env, HOOK_COMMAND: '/bin/echo' },
            stdout: 'pipe',
            stderr: 'pipe',
          })
          const [status, stdout, stderr] = await Promise.all([
            child.exited,
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
          ])
          expect({ command, status, stdout, stderr }).toEqual({
            command,
            status: 0,
            stdout: '{}\n',
            stderr: '',
          })
        }
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    },
  )
})
