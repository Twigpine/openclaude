import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'

const colorizeUrl = new URL('./colorize.ts', import.meta.url).href

// Each process imports chalk and colorize after its terminal environment is set.
// Leave two seconds for assertions beyond the 8-second subprocess deadline.
test.each([
  { force: '0', terminal: '', tmux: '', level: 0, color: 'X' },
  { force: '1', terminal: '', tmux: '', level: 1, color: '\x1b[91mX\x1b[39m' },
  { force: '2', terminal: '', tmux: '', level: 2, color: '\x1b[38;5;196mX\x1b[39m' },
  { force: '3', terminal: '', tmux: '', level: 3, color: '\x1b[38;5;196mX\x1b[39m' },
  { force: '0', terminal: 'vscode', tmux: '', level: 0, color: 'X' },
  { force: '2', terminal: 'vscode', tmux: '', level: 3, color: '\x1b[38;5;196mX\x1b[39m' },
  { force: '3', terminal: 'vscode', tmux: 'test', level: 2, color: '\x1b[38;5;196mX\x1b[39m' },
])('colorize respects FORCE_COLOR=$force, terminal=$terminal, tmux=$tmux', ({ force, terminal, tmux, level, color }) => {
  const script = `
    import chalk from 'chalk';
    import { colorize } from ${JSON.stringify(colorizeUrl)};
    process.stdout.write(JSON.stringify({
      level: chalk.level,
      foreground: colorize('X', 'ansi256(196)', 'foreground'),
      background: colorize('X', 'ansi256(196)', 'background'),
    }));
  `
  const result = spawnSync(process.execPath, ['--eval', script], {
    env: {
      ...process.env,
      FORCE_COLOR: force,
      TERM_PROGRAM: terminal,
      TMUX: tmux,
      CLAUDE_CODE_TMUX_TRUECOLOR: '',
      COLORTERM: '',
    },
    encoding: 'utf8',
    timeout: 8_000,
  })
  expect(result.error).toBeUndefined()
  expect(result.status).toBe(0)
  const rendered = JSON.parse(result.stdout)
  expect(rendered.level).toBe(level)
  expect(rendered.foreground).toBe(color)
  expect(rendered.background).toBe(level === 0 ? 'X' : level === 1
    ? '\x1b[101mX\x1b[49m'
    : '\x1b[48;5;196mX\x1b[49m')
}, 10_000)
