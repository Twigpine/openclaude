import * as React from 'react';
import type { LocalJSXCommandContext } from '../../commands.js';
import { SkillsMenu } from '../../components/skills/SkillsMenu.js';
import { getUnloadedSiblingSkillHomes } from '../../skills/loadSkillsDir.js';
import type { LocalJSXCommandOnDone } from '../../types/command.js';
export async function call(onDone: LocalJSXCommandOnDone, context: LocalJSXCommandContext): Promise<React.ReactNode> {
  const unloadedSiblingHomes = await getUnloadedSiblingSkillHomes().catch(() => []);
  return <SkillsMenu onExit={onDone} commands={context.options.commands} unloadedSiblingHomes={unloadedSiblingHomes} />;
}
