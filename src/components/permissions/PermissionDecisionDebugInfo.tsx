import { c as _c } from "react-compiler-runtime";
import { feature } from 'bun:bundle';
import chalk from 'chalk';
import figures from 'figures';
import React from 'react';
import { Ansi, Box, color, Text, useTheme } from '../../ink.js';
import { useAppState } from '../../state/AppState.js';
import type { PermissionMode } from '../../utils/permissions/PermissionMode.js';
import { permissionModeTitle } from '../../utils/permissions/PermissionMode.js';
import type { PermissionDecision, PermissionDecisionReason } from '../../utils/permissions/PermissionResult.js';
import { extractRules } from '../../utils/permissions/PermissionUpdate.js';
import type { PermissionUpdate } from '../../utils/permissions/PermissionUpdateSchema.js';
import { permissionRuleValueToString } from '../../utils/permissions/permissionRuleParser.js';
import { detectUnreachableRules } from '../../utils/permissions/shadowedRuleDetection.js';
import { SandboxManager } from '../../utils/sandbox/sandbox-adapter.js';
import { getSettingSourceDisplayNameLowercase } from '../../utils/settings/constants.js';
type PermissionDecisionInfoItemProps = {
  title?: string;
  decisionReason: PermissionDecisionReason;
};
function decisionReasonDisplayString(decisionReason: PermissionDecisionReason & {
  type: Exclude<PermissionDecisionReason['type'], 'subcommandResults'>;
}): string {
  if ((feature('BASH_CLASSIFIER') || feature('TRANSCRIPT_CLASSIFIER')) && decisionReason.type === 'classifier') {
    return `${chalk.bold(decisionReason.classifier)} classifier: ${decisionReason.reason}`;
  }
  switch (decisionReason.type) {
    case 'rule':
      return `${chalk.bold(permissionRuleValueToString(decisionReason.rule.ruleValue))} rule from ${getSettingSourceDisplayNameLowercase(decisionReason.rule.source)}`;
    case 'mode':
      return `${permissionModeTitle(decisionReason.mode)} mode`;
    case 'sandboxOverride':
      return 'Requires permission to bypass sandbox';
    case 'workingDir':
      return decisionReason.reason;
    case 'safetyCheck':
    case 'other':
      return decisionReason.reason;
    case 'permissionPromptTool':
      return `${chalk.bold(decisionReason.permissionPromptToolName)} permission prompt tool`;
    case 'hook':
      return decisionReason.reason ? `${chalk.bold(decisionReason.hookName)} hook: ${decisionReason.reason}` : `${chalk.bold(decisionReason.hookName)} hook`;
    case 'asyncAgent':
      return decisionReason.reason;
    default:
      return '';
  }
}
function PermissionDecisionInfoItem(t0: PermissionDecisionInfoItemProps): React.ReactNode {
  const $ = _c(10);
  const {
    title,
    decisionReason
  } = t0;
  const [theme] = useTheme();
  let t1;
  if ($[0] !== decisionReason || $[1] !== theme) {
    t1 = function formatDecisionReason() {
      switch (decisionReason.type) {
        case "subcommandResults":
          {
            return <Box flexDirection="column">{Array.from(decisionReason.reasons.entries()).map(t2 => {
                const [subcommand, result] = t2;
                const icon = result.behavior === "allow" ? color("success", theme)(figures.tick) : color("error", theme)(figures.cross);
                return <Box flexDirection="column" key={subcommand}><Text>{icon} {subcommand}</Text>{result.decisionReason !== undefined && result.decisionReason.type !== "subcommandResults" && <Text><Text dimColor={true}>{"  "}└{"  "}</Text><Ansi>{decisionReasonDisplayString(result.decisionReason)}</Ansi></Text>}{result.behavior === "ask" && <SuggestedRules suggestions={result.suggestions} />}</Box>;
              })}</Box>;
          }
        default:
          {
            return <Text><Ansi>{decisionReasonDisplayString(decisionReason)}</Ansi></Text>;
          }
      }
    };
    $[0] = decisionReason;
    $[1] = theme;
    $[2] = t1;
  } else {
    t1 = $[2];
  }
  const formatDecisionReason = t1;
  let t2;
  if ($[3] !== title) {
    t2 = title && <Text>{title}</Text>;
    $[3] = title;
    $[4] = t2;
  } else {
    t2 = $[4];
  }
  let t3;
  if ($[5] !== formatDecisionReason) {
    t3 = formatDecisionReason();
    $[5] = formatDecisionReason;
    $[6] = t3;
  } else {
    t3 = $[6];
  }
  let t4;
  if ($[7] !== t2 || $[8] !== t3) {
    t4 = <Box flexDirection="column">{t2}{t3}</Box>;
    $[7] = t2;
    $[8] = t3;
    $[9] = t4;
  } else {
    t4 = $[9];
  }
  return t4;
}
function SuggestedRules(t0: {
  suggestions?: PermissionUpdate[];
}): React.ReactNode {
  const $ = _c(18);
  const {
    suggestions
  } = t0;
  let T0;
  let T1;
  let t1;
  let t2;
  let t3;
  let t4;
  let t5;
  if ($[0] !== suggestions) {
    t5 = Symbol.for("react.early_return_sentinel");
    bb0: {
      const rules = extractRules(suggestions);
      if (rules.length === 0) {
        t5 = null;
        break bb0;
      }
      T1 = Text;
      if ($[8] === Symbol.for("react.memo_cache_sentinel")) {
        t2 = <Text dimColor={true}>{"  "}└{"  "}</Text>;
        $[8] = t2;
      } else {
        t2 = $[8];
      }
      t3 = "Suggested rules:";
      t4 = " ";
      T0 = Ansi;
      t1 = rules.map(_temp).join(", ");
    }
    $[0] = suggestions;
    $[1] = T0;
    $[2] = T1;
    $[3] = t1;
    $[4] = t2;
    $[5] = t3;
    $[6] = t4;
    $[7] = t5;
  } else {
    T0 = $[1];
    T1 = $[2];
    t1 = $[3];
    t2 = $[4];
    t3 = $[5];
    t4 = $[6];
    t5 = $[7];
  }
  if (t5 !== Symbol.for("react.early_return_sentinel")) {
    return t5;
  }
  let t6;
  if ($[9] !== T0 || $[10] !== t1) {
    t6 = <T0>{t1}</T0>;
    $[9] = T0;
    $[10] = t1;
    $[11] = t6;
  } else {
    t6 = $[11];
  }
  let t7;
  if ($[12] !== T1 || $[13] !== t2 || $[14] !== t3 || $[15] !== t4 || $[16] !== t6) {
    t7 = <T1>{t2}{t3}{t4}{t6}</T1>;
    $[12] = T1;
    $[13] = t2;
    $[14] = t3;
    $[15] = t4;
    $[16] = t6;
    $[17] = t7;
  } else {
    t7 = $[17];
  }
  return t7;
}
function _temp(rule) {
  return chalk.bold(permissionRuleValueToString(rule));
}
type Props = {
  permissionResult: PermissionDecision;
  toolName?: string; // Filter unreachable rules to this tool
};

// Helper function to extract directories from permission updates
function extractDirectories(updates: PermissionUpdate[] | undefined): string[] {
  if (!updates) return [];
  return updates.flatMap(update => {
    switch (update.type) {
      case 'addDirectories':
        return update.directories;
      default:
        return [];
    }
  });
}

// Helper function to extract mode from permission updates
function extractMode(updates: PermissionUpdate[] | undefined): PermissionMode | undefined {
  if (!updates) return undefined;
  const update = updates.findLast(u => u.type === 'setMode');
  return update?.type === 'setMode' ? update.mode : undefined;
}
function SuggestionDisplay(t0) {
  const $ = _c(22);
  const {
    suggestions,
    width
  } = t0;
  if (!suggestions || suggestions.length === 0) {
    let t1;
    if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
      t1 = <Text dimColor={true}>Suggestions </Text>;
      $[0] = t1;
    } else {
      t1 = $[0];
    }
    let t2;
    if ($[1] !== width) {
      t2 = <Box justifyContent="flex-end" minWidth={width}>{t1}</Box>;
      $[1] = width;
      $[2] = t2;
    } else {
      t2 = $[2];
    }
    let t3;
    if ($[3] === Symbol.for("react.memo_cache_sentinel")) {
      t3 = <Text>None</Text>;
      $[3] = t3;
    } else {
      t3 = $[3];
    }
    let t4;
    if ($[4] !== t2) {
      t4 = <Box flexDirection="row">{t2}{t3}</Box>;
      $[4] = t2;
      $[5] = t4;
    } else {
      t4 = $[5];
    }
    return t4;
  }
  let t1;
  let t2;
  if ($[6] !== suggestions || $[7] !== width) {
    t2 = Symbol.for("react.early_return_sentinel");
    bb0: {
      const rules = extractRules(suggestions);
      const directories = extractDirectories(suggestions);
      const mode = extractMode(suggestions);
      if (rules.length === 0 && directories.length === 0 && !mode) {
        let t3;
        if ($[10] === Symbol.for("react.memo_cache_sentinel")) {
          t3 = <Text dimColor={true}>Suggestion </Text>;
          $[10] = t3;
        } else {
          t3 = $[10];
        }
        let t4;
        if ($[11] !== width) {
          t4 = <Box justifyContent="flex-end" minWidth={width}>{t3}</Box>;
          $[11] = width;
          $[12] = t4;
        } else {
          t4 = $[12];
        }
        let t5;
        if ($[13] === Symbol.for("react.memo_cache_sentinel")) {
          t5 = <Text>None</Text>;
          $[13] = t5;
        } else {
          t5 = $[13];
        }
        let t6;
        if ($[14] !== t4) {
          t6 = <Box flexDirection="row">{t4}{t5}</Box>;
          $[14] = t4;
          $[15] = t6;
        } else {
          t6 = $[15];
        }
        t2 = t6;
        break bb0;
      }
      let t3;
      if ($[16] === Symbol.for("react.memo_cache_sentinel")) {
        t3 = <Text dimColor={true}>Suggestions </Text>;
        $[16] = t3;
      } else {
        t3 = $[16];
      }
      let t4;
      if ($[17] !== width) {
        t4 = <Box justifyContent="flex-end" minWidth={width}>{t3}</Box>;
        $[17] = width;
        $[18] = t4;
      } else {
        t4 = $[18];
      }
      let t5;
      if ($[19] === Symbol.for("react.memo_cache_sentinel")) {
        t5 = <Text> </Text>;
        $[19] = t5;
      } else {
        t5 = $[19];
      }
      let t6;
      if ($[20] !== t4) {
        t6 = <Box flexDirection="row">{t4}{t5}</Box>;
        $[20] = t4;
        $[21] = t6;
      } else {
        t6 = $[21];
      }
      t1 = <Box flexDirection="column">{t6}{rules.length > 0 && <Box flexDirection="row"><Box justifyContent="flex-end" minWidth={width}><Text dimColor={true}> Rules </Text></Box><Box flexDirection="column">{rules.map(_temp2)}</Box></Box>}{directories.length > 0 && <Box flexDirection="row"><Box justifyContent="flex-end" minWidth={width}><Text dimColor={true}> Directories </Text></Box><Box flexDirection="column">{directories.map(_temp3)}</Box></Box>}{mode && <Box flexDirection="row"><Box justifyContent="flex-end" minWidth={width}><Text dimColor={true}> Mode </Text></Box><Text>{permissionModeTitle(mode)}</Text></Box>}</Box>;
    }
    $[6] = suggestions;
    $[7] = width;
    $[8] = t1;
    $[9] = t2;
  } else {
    t1 = $[8];
    t2 = $[9];
  }
  if (t2 !== Symbol.for("react.early_return_sentinel")) {
    return t2;
  }
  return t1;
}
function _temp3(dir, index_0) {
  return <Text key={index_0}>{figures.bullet} {dir}</Text>;
}
function _temp2(rule, index) {
  return <Text key={index}>{figures.bullet} {permissionRuleValueToString(rule)}</Text>;
}
export function PermissionDecisionDebugInfo(t0) {
  const $ = _c(25);
  const {
    permissionResult,
    toolName
  } = t0;
  const toolPermissionContext = useAppState(_temp4);
  const decisionReason = permissionResult.decisionReason;
  const suggestions = "suggestions" in permissionResult ? permissionResult.suggestions : undefined;
  let t1;
  if ($[0] !== suggestions || $[1] !== toolName || $[2] !== toolPermissionContext) {
    bb0: {
      const sandboxAutoAllowEnabled = SandboxManager.isSandboxingEnabled() && SandboxManager.isAutoAllowBashIfSandboxedEnabled();
      const all = detectUnreachableRules(toolPermissionContext, {
        sandboxAutoAllowEnabled
      });
      const suggestedRules = extractRules(suggestions);
      if (suggestedRules.length > 0) {
        t1 = all.filter(u => suggestedRules.some(suggested => suggested.toolName === u.rule.ruleValue.toolName && suggested.ruleContent === u.rule.ruleValue.ruleContent));
        break bb0;
      }
      if (toolName) {
        let t2;
        if ($[4] !== toolName) {
          t2 = u_0 => u_0.rule.ruleValue.toolName === toolName;
          $[4] = toolName;
          $[5] = t2;
        } else {
          t2 = $[5];
        }
        t1 = all.filter(t2);
        break bb0;
      }
      t1 = all;
    }
    $[0] = suggestions;
    $[1] = toolName;
    $[2] = toolPermissionContext;
    $[3] = t1;
  } else {
    t1 = $[3];
  }
  const unreachableRules = t1;
  let t2;
  if ($[6] === Symbol.for("react.memo_cache_sentinel")) {
    t2 = <Box justifyContent="flex-end" minWidth={10}><Text dimColor={true}>Behavior </Text></Box>;
    $[6] = t2;
  } else {
    t2 = $[6];
  }
  let t3;
  if ($[7] !== permissionResult.behavior) {
    t3 = <Box flexDirection="row">{t2}<Text>{permissionResult.behavior}</Text></Box>;
    $[7] = permissionResult.behavior;
    $[8] = t3;
  } else {
    t3 = $[8];
  }
  let t4;
  if ($[9] !== permissionResult.behavior || $[10] !== permissionResult.message) {
    t4 = permissionResult.behavior !== "allow" && <Box flexDirection="row"><Box justifyContent="flex-end" minWidth={10}><Text dimColor={true}>Message </Text></Box><Text>{permissionResult.message}</Text></Box>;
    $[9] = permissionResult.behavior;
    $[10] = permissionResult.message;
    $[11] = t4;
  } else {
    t4 = $[11];
  }
  let t5;
  if ($[12] === Symbol.for("react.memo_cache_sentinel")) {
    t5 = <Box justifyContent="flex-end" minWidth={10}><Text dimColor={true}>Reason </Text></Box>;
    $[12] = t5;
  } else {
    t5 = $[12];
  }
  let t6;
  if ($[13] !== decisionReason) {
    t6 = <Box flexDirection="row">{t5}{decisionReason === undefined ? <Text>undefined</Text> : <PermissionDecisionInfoItem decisionReason={decisionReason} />}</Box>;
    $[13] = decisionReason;
    $[14] = t6;
  } else {
    t6 = $[14];
  }
  let t7;
  if ($[15] !== suggestions) {
    t7 = <SuggestionDisplay suggestions={suggestions} width={10} />;
    $[15] = suggestions;
    $[16] = t7;
  } else {
    t7 = $[16];
  }
  let t8;
  if ($[17] !== unreachableRules) {
    t8 = unreachableRules.length > 0 && <Box flexDirection="column" marginTop={1}><Text color="warning">{figures.warning} Unreachable Rules ({unreachableRules.length})</Text>{unreachableRules.map(_temp5)}</Box>;
    $[17] = unreachableRules;
    $[18] = t8;
  } else {
    t8 = $[18];
  }
  let t9;
  if ($[19] !== t3 || $[20] !== t4 || $[21] !== t6 || $[22] !== t7 || $[23] !== t8) {
    t9 = <Box flexDirection="column">{t3}{t4}{t6}{t7}{t8}</Box>;
    $[19] = t3;
    $[20] = t4;
    $[21] = t6;
    $[22] = t7;
    $[23] = t8;
    $[24] = t9;
  } else {
    t9 = $[24];
  }
  return t9;
}
function _temp5(u_1, i) {
  return <Box key={i} flexDirection="column" marginLeft={2}><Text color="warning">{permissionRuleValueToString(u_1.rule.ruleValue)}</Text><Text dimColor={true}>{"  "}{u_1.reason}</Text><Text dimColor={true}>{"  "}Fix: {u_1.fix}</Text></Box>;
}
function _temp4(s) {
  return s.toolPermissionContext;
}
