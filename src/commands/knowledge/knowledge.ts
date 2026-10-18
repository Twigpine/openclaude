import type { LocalCommandCall } from '../../types/command.js';
import { getArcSummary, resetArc, getArcStats, clearArcArtifacts } from '../../utils/conversationArc.js';
import { getAutoMemPath } from '../../memdir/paths.js';
import { getGlobalGraph, resetGlobalGraph } from '../../utils/knowledgeGraph.js';
import { resetMultiTurnState } from '../../utils/multiTurnContext.js';
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js';
import chalk from 'chalk';

export const call: LocalCommandCall = async (args, _context) => {
  const arg = (args ? String(args) : '').trim().toLowerCase();
  const splitArgs = arg.split(/\s+/).filter(Boolean);
  const subCommand = splitArgs[0];

  if (!subCommand || subCommand === 'status') {
    const config = getGlobalConfig();

    const statusText = (config.knowledgeGraphEnabled !== false)
      ? chalk.green('ENABLED')
      : chalk.red('DISABLED');

    let output = `${chalk.bold('Knowledge Graph Engine')}: ${statusText}\n`;

    // Do not initialize or migrate when disabled (P2).
    if (config.knowledgeGraphEnabled !== false) {
      const stats = getArcStats();
      const graph = getGlobalGraph();
      const entityCount = Object.keys(graph.entities).length;
      if (stats) {
        output += `• Stats: ${stats.goalCount} goals, ${stats.milestoneCount} milestones, ${entityCount} technical facts learned`;
      }
    }

    return { type: 'text', value: output };
  }

  if (subCommand === 'enable') {
    const val = splitArgs[1];
    const isEnabled = val === 'yes' || val === 'true';
    const isDisabled = val === 'no' || val === 'false';

    if (!isEnabled && !isDisabled) {
      return { type: 'text', value: 'Usage: /knowledge enable <yes|no>' };
    }

    saveGlobalConfig(current => ({ ...current, knowledgeGraphEnabled: isEnabled }));
    return {
      type: 'text',
      value: `✨ Knowledge Graph engine ${isEnabled ? chalk.green('enabled') : chalk.red('disabled')}.`
    };
  }

  if (subCommand === 'clear') {
    resetArc();
    const retireResult = resetGlobalGraph();
    resetMultiTurnState();
    const memDir = getAutoMemPath();
    if (memDir) {
      clearArcArtifacts(memDir);
    }
    if (retireResult.failures.length > 0) {
      return {
        type: 'text',
        value: '⚠️ Knowledge graph memory cleared, but the following legacy artifacts could not be backed up and were left in place — resolve any read/write issue and retry: '
          + retireResult.failures.join(', ')
          + '.'
      };
    }
    return {
      type: 'text',
      value: '🗑️ Knowledge graph memory has been cleared (all .facts files, vector index, arc state, and multi-turn tracking removed'.concat(
        retireResult.archived.length > 0
          ? `; ${retireResult.archived.length} legacy artifact(s) verified and archived alongside originals`
          : '; no legacy JSON/SQLite stores present',
        ').',
      )
    };
  }

  if (subCommand === 'list') {
    const config = getGlobalConfig();
    if (config.knowledgeGraphEnabled === false) {
      return { type: 'text', value: 'Knowledge graph is disabled.' };
    }
    return { type: 'text', value: await getArcSummary() };
  }

  return {
    type: 'text',
    value: `Unknown subcommand: ${subCommand}. Available: enable, clear, status, list`
  };
};
