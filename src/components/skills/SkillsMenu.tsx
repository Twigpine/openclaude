import capitalize from 'lodash-es/capitalize.js';
import * as React from 'react';
import { useCallback, useMemo } from 'react';
import { type Command, type CommandBase, type CommandResultDisplay, type PromptCommand } from '../../commands.js';
import { Box, Text } from '../../ink.js';
import { estimateSkillFrontmatterTokens, getSkillsPath } from '../../skills/loadSkillsDir.js';
import { getSiblingSkillsHomeDisplayPath, SIBLING_SKILL_HOMES, type SiblingSkillsHome, type SiblingSkillsHomeId } from '../../skills/siblingSkillHomes.js';
import { getDisplayPath } from '../../utils/file.js';
import { formatTokens } from '../../utils/format.js';
import { getUserSkillExampleDisplayPath } from '../../utils/openclaudeDisplayPaths.js';
import { getSettingSourceName, type SettingSource } from '../../utils/settings/constants.js';
import { plural } from '../../utils/stringUtils.js';
import { ConfigurableShortcutHint } from '../ConfigurableShortcutHint.js';
import { Dialog } from '../design-system/Dialog.js';
import FullWidthRow from '../design-system/FullWidthRow.js';

// Skills are always PromptCommands with CommandBase properties
type SkillCommand = CommandBase & PromptCommand;
type SkillSource = SettingSource | 'plugin' | 'mcp';
export type UnloadedSiblingSkillsHome = {
  home: SiblingSkillsHome;
  count: number;
};
type Props = {
  onExit: (result?: string, options?: {
    display?: CommandResultDisplay;
  }) => void;
  commands: Command[];
  unloadedSiblingHomes?: UnloadedSiblingSkillsHome[];
};
export type SkillsMenuGroup = {
  key: string;
  title: string;
  subtitle: string | undefined;
  skills: SkillCommand[];
};

// Render order. Skills from other agents' homes come last, matching their
// precedence.
const SOURCE_GROUP_ORDER: SkillSource[] = ['projectSettings', 'userSettings', 'policySettings', 'plugin', 'mcp'];
function getSourceTitle(source: SkillSource): string {
  if (source === 'plugin') {
    return 'Plugin skills';
  }
  if (source === 'mcp') {
    return 'MCP skills';
  }
  return `${capitalize(getSettingSourceName(source))} skills`;
}
function getSourceSubtitle(source: SkillSource, skills: SkillCommand[]): string | undefined {
  // MCP skills show server names; file-based skills show filesystem paths.
  // Skill names are `<server>:<skill>`, not `mcp__<server>__…`.
  if (source === 'mcp') {
    const servers = [...new Set(skills.map(s => {
      const idx = s.name.indexOf(':');
      return idx > 0 ? s.name.slice(0, idx) : null;
    }).filter((n): n is string => n != null))];
    return servers.length > 0 ? servers.join(', ') : undefined;
  }
  const skillsPath = getDisplayPath(getSkillsPath(source, 'skills'));
  const hasCommandsSkills = skills.some(s => s.loadedFrom === 'commands_DEPRECATED');
  return hasCommandsSkills ? `${skillsPath}, ${getDisplayPath(getSkillsPath(source, 'commands'))}` : skillsPath;
}
function getSkillListLabel(skill: SkillCommand): string {
  const leafName = skill.name.split(':').pop() ?? skill.name;
  return leafName === skill.name ? skill.name : `${skill.name} - ${leafName}`;
}
function isMenuSkill(cmd: Command): cmd is SkillCommand {
  return cmd.type === 'prompt' && (cmd.loadedFrom === 'skills' || cmd.loadedFrom === 'commands_DEPRECATED' || cmd.loadedFrom === 'plugin' || cmd.loadedFrom === 'mcp');
}
function byName(a: SkillCommand, b: SkillCommand): number {
  return a.name.localeCompare(b.name);
}
export function getEmptySkillsMenuMessage(): string {
  return `Create skills in .openclaude/skills/<name>/SKILL.md or ${getUserSkillExampleDisplayPath()}`;
}
export function getUnloadedSiblingSkillsHint({
  home,
  count
}: UnloadedSiblingSkillsHome): string {
  return `${count} ${plural(count, 'skill')} in ${getSiblingSkillsHomeDisplayPath(home)} ${count === 1 ? "isn't" : "aren't"} loaded — enable "${home.configLabel}" in /config`;
}

/**
 * Groups menu skills by where they were loaded from. Skills read from another
 * agent's home get their own group instead of being listed under the
 * OpenClaude user skills directory.
 */
export function groupSkillsForMenu(skills: SkillCommand[]): SkillsMenuGroup[] {
  const bySource = new Map<SkillSource, SkillCommand[]>();
  const bySiblingHome = new Map<SiblingSkillsHomeId, SkillCommand[]>();
  for (const skill of skills) {
    if (skill.siblingSkillsHome) {
      bySiblingHome.set(skill.siblingSkillsHome, [...(bySiblingHome.get(skill.siblingSkillsHome) ?? []), skill]);
    } else {
      const source = skill.source as SkillSource;
      bySource.set(source, [...(bySource.get(source) ?? []), skill]);
    }
  }
  const groups: SkillsMenuGroup[] = SOURCE_GROUP_ORDER.map(source => {
    const groupSkills = (bySource.get(source) ?? []).sort(byName);
    return {
      key: source,
      title: getSourceTitle(source),
      subtitle: groupSkills.length > 0 ? getSourceSubtitle(source, groupSkills) : undefined,
      skills: groupSkills
    };
  });
  for (const home of SIBLING_SKILL_HOMES) {
    groups.push({
      key: `sibling:${home.id}`,
      title: home.title,
      subtitle: getSiblingSkillsHomeDisplayPath(home),
      skills: (bySiblingHome.get(home.id) ?? []).sort(byName)
    });
  }
  return groups.filter(group => group.skills.length > 0);
}
function renderSkill(skill: SkillCommand): React.ReactNode {
  const estimatedTokens = estimateSkillFrontmatterTokens(skill);
  const tokenDisplay = `~${formatTokens(estimatedTokens)}`;
  const pluginName = skill.source === 'plugin' ? skill.pluginInfo?.pluginManifest.name : undefined;
  return <FullWidthRow key={`${skill.name}-${skill.source}-${skill.siblingSkillsHome ?? ''}`}><Text>{getSkillListLabel(skill)}</Text><Text dimColor>{pluginName ? ` · ${pluginName}` : ''} · {tokenDisplay} description tokens</Text></FullWidthRow>;
}
export function SkillsMenu({
  onExit,
  commands,
  unloadedSiblingHomes = []
}: Props): React.ReactNode {
  const skills = useMemo(() => commands.filter(isMenuSkill), [commands]);
  const groups = useMemo(() => groupSkillsForMenu(skills), [skills]);
  const handleCancel = useCallback(() => {
    onExit('Skills dialog dismissed', {
      display: 'system'
    });
  }, [onExit]);
  const hints = unloadedSiblingHomes.map(unloaded => <FullWidthRow key={unloaded.home.id}><Text dimColor>{getUnloadedSiblingSkillsHint(unloaded)}</Text></FullWidthRow>);
  const closeHint = <FullWidthRow><Text dimColor italic><ConfigurableShortcutHint action="confirm:no" context="Confirmation" fallback="Esc" description="close" /></Text></FullWidthRow>;
  if (skills.length === 0) {
    return <Dialog title="Skills" subtitle="No skills found" onCancel={handleCancel} hideInputGuide><FullWidthRow><Text dimColor>{getEmptySkillsMenuMessage()}</Text></FullWidthRow>{hints}{closeHint}</Dialog>;
  }
  return <Dialog title="Skills" subtitle={`${skills.length} ${plural(skills.length, 'skill')}`} onCancel={handleCancel} hideInputGuide>
      <Box flexDirection="column" gap={1}>
        {groups.map(group => <Box flexDirection="column" key={group.key}>
            <FullWidthRow><Text bold dimColor>{group.title}</Text>{group.subtitle && <Text dimColor> ({group.subtitle})</Text>}</FullWidthRow>
            {group.skills.map(renderSkill)}
          </Box>)}
      </Box>
      {hints.length > 0 && <Box flexDirection="column">{hints}</Box>}
      {closeHint}
    </Dialog>;
}
