import { parse, resolve } from 'node:path'

const tsconfigPath = resolve(import.meta.dir, '../tsconfig.json')
// Outside the project, `bun check` invokes the builtin instead of our check script.
const result = Bun.spawnSync([process.execPath, 'check', '-p', tsconfigPath], {
  cwd: parse(tsconfigPath).root,
  stdin: 'inherit',
  stdout: 'inherit',
  stderr: 'inherit',
})

if (!result.success) process.exit(result.exitCode ?? 1)
process.exit(0)
