import { getSkillDirCommands } from '../../skills/loadSkillsDir.js'
import type { LocalCommandCall } from '../../types/command.js'
import { getCwd } from '../../utils/cwd.js'
import { skillChangeDetector } from '../../utils/skills/skillChangeDetector.js'
import { plural } from '../../utils/stringUtils.js'

async function skillNames(): Promise<Set<string>> {
  const commands = await getSkillDirCommands(getCwd())
  return new Set(commands.map(command => command.name))
}

export const call: LocalCommandCall = async (_args, _context) => {
  const before = await skillNames()

  // Same cache sweep and change signal the file watcher performs; it also
  // reconciles which skill homes are watched.
  await skillChangeDetector.reloadAfterSkillSourceSettingsChange()

  const after = await skillNames()
  const added = [...after].filter(name => !before.has(name)).sort()
  const removed = [...before].filter(name => !after.has(name)).sort()

  if (added.length === 0 && removed.length === 0) {
    return {
      type: 'text',
      value: `Reloaded skills. No changes (${after.size} ${plural(after.size, 'skill')} loaded).`,
    }
  }

  const parts: string[] = []
  if (added.length > 0) {
    parts.push(`${added.length} added (${added.join(', ')})`)
  }
  if (removed.length > 0) {
    parts.push(`${removed.length} removed (${removed.join(', ')})`)
  }
  return {
    type: 'text',
    value: `Reloaded skills: ${parts.join(', ')}.`,
  }
}
