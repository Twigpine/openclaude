import { c as _c } from "react-compiler-runtime";
import figures from 'figures';
import React, { useState } from 'react';
import { mcpInfoFromString } from 'src/services/mcp/mcpStringUtils.js';
import { isMcpTool } from 'src/services/mcp/utils.js';
import type { Tool, Tools } from 'src/Tool.js';
import { filterToolsForAgent } from 'src/tools/AgentTool/agentToolUtils.js';
import { AGENT_TOOL_NAME } from 'src/tools/AgentTool/constants.js';
import { BashTool } from 'src/tools/BashTool/BashTool.js';
import { ExitPlanModeV2Tool } from 'src/tools/ExitPlanModeTool/ExitPlanModeV2Tool.js';
import { FileEditTool } from 'src/tools/FileEditTool/FileEditTool.js';
import { FileReadTool } from 'src/tools/FileReadTool/FileReadTool.js';
import { FileWriteTool } from 'src/tools/FileWriteTool/FileWriteTool.js';
import { GlobTool } from 'src/tools/GlobTool/GlobTool.js';
import { GrepTool } from 'src/tools/GrepTool/GrepTool.js';
import { ListMcpResourcesTool } from 'src/tools/ListMcpResourcesTool/ListMcpResourcesTool.js';
import { NotebookEditTool } from 'src/tools/NotebookEditTool/NotebookEditTool.js';
import { ReadMcpResourceTool } from 'src/tools/ReadMcpResourceTool/ReadMcpResourceTool.js';
import { TaskOutputTool } from 'src/tools/TaskOutputTool/TaskOutputTool.js';
import { TaskStopTool } from 'src/tools/TaskStopTool/TaskStopTool.js';
import { TodoWriteTool } from 'src/tools/TodoWriteTool/TodoWriteTool.js';
import { TungstenTool } from 'src/tools/TungstenTool/TungstenTool.js';
import { WebFetchTool } from 'src/tools/WebFetchTool/WebFetchTool.js';
import { WebSearchTool } from 'src/tools/WebSearchTool/WebSearchTool.js';
import type { KeyboardEvent } from '../../ink/events/keyboard-event.js';
import { Box, Text } from '../../ink.js';
import { useKeybinding } from '../../keybindings/useKeybinding.js';
import { count } from '../../utils/array.js';
import { plural } from '../../utils/stringUtils.js';
import { Divider } from '../design-system/Divider.js';
type Props = {
  tools: Tools;
  initialTools: string[] | undefined;
  onComplete: (selectedTools: string[] | undefined) => void;
  onCancel?: () => void;
};
type ToolBucket = {
  name: string;
  toolNames: Set<string>;
  isMcp?: boolean;
};
type ToolBuckets = {
  READ_ONLY: ToolBucket;
  EDIT: ToolBucket;
  EXECUTION: ToolBucket;
  MCP: ToolBucket;
  OTHER: ToolBucket;
};
function getToolBuckets(): ToolBuckets {
  return {
    READ_ONLY: {
      name: 'Read-only tools',
      toolNames: new Set([GlobTool.name, GrepTool.name, ExitPlanModeV2Tool.name, FileReadTool.name, WebFetchTool.name, TodoWriteTool.name, WebSearchTool.name, TaskStopTool.name, TaskOutputTool.name, ListMcpResourcesTool.name, ReadMcpResourceTool.name])
    },
    EDIT: {
      name: 'Edit tools',
      toolNames: new Set([FileEditTool.name, FileWriteTool.name, NotebookEditTool.name])
    },
    EXECUTION: {
      name: 'Execution tools',
      toolNames: new Set([BashTool.name])
    },
    MCP: {
      name: 'MCP tools',
      toolNames: new Set(),
      // Dynamic - no static list
      isMcp: true
    },
    OTHER: {
      name: 'Other tools',
      toolNames: new Set() // Dynamic - catch-all for uncategorized tools
    }
  };
}

// Helper to get MCP server buckets dynamically
function getMcpServerBuckets(tools: Tools): Array<{
  serverName: string;
  tools: Tools;
}> {
  const serverMap = new Map<string, Tool[]>();
  tools.forEach(tool => {
    if (isMcpTool(tool)) {
      const mcpInfo = mcpInfoFromString(tool.name);
      if (mcpInfo?.serverName) {
        const existing = serverMap.get(mcpInfo.serverName) || [];
        existing.push(tool);
        serverMap.set(mcpInfo.serverName, existing);
      }
    }
  });
  return Array.from(serverMap.entries()).map(([serverName, tools]) => ({
    serverName,
    tools
  })).sort((a, b) => a.serverName.localeCompare(b.serverName));
}
export function ToolSelector(t0) {
  const $ = _c(69);
  const {
    tools,
    initialTools,
    onComplete,
    onCancel
  } = t0;
  let t1;
  if ($[0] !== tools) {
    t1 = filterToolsForAgent({
      tools,
      isBuiltIn: false,
      isAsync: false
    });
    $[0] = tools;
    $[1] = t1;
  } else {
    t1 = $[1];
  }
  const customAgentTools = t1;
  let t2;
  if ($[2] !== customAgentTools || $[3] !== initialTools) {
    t2 = !initialTools || initialTools.includes("*") ? customAgentTools.map(_temp) : initialTools;
    $[2] = customAgentTools;
    $[3] = initialTools;
    $[4] = t2;
  } else {
    t2 = $[4];
  }
  const expandedInitialTools = t2;
  const [selectedTools, setSelectedTools] = useState(expandedInitialTools);
  const [focusIndex, setFocusIndex] = useState(0);
  const [showIndividualTools, setShowIndividualTools] = useState(false);
  let t3;
  if ($[5] !== customAgentTools) {
    t3 = new Set(customAgentTools.map(_temp2));
    $[5] = customAgentTools;
    $[6] = t3;
  } else {
    t3 = $[6];
  }
  const toolNames = t3;
  let t4;
  if ($[7] !== selectedTools || $[8] !== toolNames) {
    let t5;
    if ($[10] !== toolNames) {
      t5 = name => toolNames.has(name);
      $[10] = toolNames;
      $[11] = t5;
    } else {
      t5 = $[11];
    }
    t4 = selectedTools.filter(t5);
    $[7] = selectedTools;
    $[8] = toolNames;
    $[9] = t4;
  } else {
    t4 = $[9];
  }
  const validSelectedTools = t4;
  let t5;
  if ($[12] !== validSelectedTools) {
    t5 = new Set(validSelectedTools);
    $[12] = validSelectedTools;
    $[13] = t5;
  } else {
    t5 = $[13];
  }
  const selectedSet = t5;
  const isAllSelected = validSelectedTools.length === customAgentTools.length && customAgentTools.length > 0;
  let t6;
  if ($[14] === Symbol.for("react.memo_cache_sentinel")) {
    t6 = toolName => {
      if (!toolName) {
        return;
      }
      setSelectedTools(current => current.includes(toolName) ? current.filter(t_1 => t_1 !== toolName) : [...current, toolName]);
    };
    $[14] = t6;
  } else {
    t6 = $[14];
  }
  const handleToggleTool = t6;
  let t7;
  if ($[15] === Symbol.for("react.memo_cache_sentinel")) {
    t7 = (toolNames_0, select) => {
      setSelectedTools(current_0 => {
        if (select) {
          const toolsToAdd = toolNames_0.filter(t_2 => !current_0.includes(t_2));
          return [...current_0, ...toolsToAdd];
        } else {
          return current_0.filter(t_3 => !toolNames_0.includes(t_3));
        }
      });
    };
    $[15] = t7;
  } else {
    t7 = $[15];
  }
  const handleToggleTools = t7;
  let t8;
  if ($[16] !== customAgentTools || $[17] !== onComplete || $[18] !== validSelectedTools) {
    t8 = () => {
      const allToolNames = customAgentTools.map(_temp3);
      const areAllToolsSelected = validSelectedTools.length === allToolNames.length && allToolNames.every(name_0 => validSelectedTools.includes(name_0));
      const finalTools = areAllToolsSelected ? undefined : validSelectedTools;
      onComplete(finalTools);
    };
    $[16] = customAgentTools;
    $[17] = onComplete;
    $[18] = validSelectedTools;
    $[19] = t8;
  } else {
    t8 = $[19];
  }
  const handleConfirm = t8;
  let buckets;
  if ($[20] !== customAgentTools) {
    const toolBuckets = getToolBuckets();
    buckets = {
      readOnly: [] as Tool[],
      edit: [] as Tool[],
      execution: [] as Tool[],
      mcp: [] as Tool[],
      other: [] as Tool[]
    };
    customAgentTools.forEach(tool => {
      if (isMcpTool(tool)) {
        buckets.mcp.push(tool);
      } else {
        if (toolBuckets.READ_ONLY.toolNames.has(tool.name)) {
          buckets.readOnly.push(tool);
        } else {
          if (toolBuckets.EDIT.toolNames.has(tool.name)) {
            buckets.edit.push(tool);
          } else {
            if (toolBuckets.EXECUTION.toolNames.has(tool.name)) {
              buckets.execution.push(tool);
            } else {
              if (tool.name !== AGENT_TOOL_NAME) {
                buckets.other.push(tool);
              }
            }
          }
        }
      }
    });
    $[20] = customAgentTools;
    $[21] = buckets;
  } else {
    buckets = $[21];
  }
  const toolsByBucket = buckets;
  let t9;
  if ($[22] !== selectedSet) {
    t9 = (bucketTools: Tool[]) => {
      const selected = count(bucketTools, t_5 => selectedSet.has(t_5.name));
      const needsSelection = selected < bucketTools.length;
      return () => {
        const toolNames_1 = bucketTools.map(_temp4);
        handleToggleTools(toolNames_1, needsSelection);
      };
    };
    $[22] = selectedSet;
    $[23] = t9;
  } else {
    t9 = $[23];
  }
  const createBucketToggleAction = t9;
  let navigableItems;
  if ($[24] !== createBucketToggleAction || $[25] !== customAgentTools || $[26] !== focusIndex || $[27] !== handleConfirm || $[28] !== isAllSelected || $[29] !== selectedSet || $[30] !== showIndividualTools || $[31] !== toolsByBucket.edit || $[32] !== toolsByBucket.execution || $[33] !== toolsByBucket.mcp || $[34] !== toolsByBucket.other || $[35] !== toolsByBucket.readOnly) {
    navigableItems = [];
    navigableItems.push({
      id: "continue",
      label: "Continue",
      action: handleConfirm,
      isContinue: true
    });
    let t10;
    if ($[37] !== customAgentTools || $[38] !== isAllSelected) {
      t10 = () => {
        const allToolNames_0 = customAgentTools.map(_temp5);
        handleToggleTools(allToolNames_0, !isAllSelected);
      };
      $[37] = customAgentTools;
      $[38] = isAllSelected;
      $[39] = t10;
    } else {
      t10 = $[39];
    }
    navigableItems.push({
      id: "bucket-all",
      label: `${isAllSelected ? figures.checkboxOn : figures.checkboxOff} All tools`,
      action: t10
    });
    const toolBuckets_0 = getToolBuckets();
    const bucketConfigs = [{
      id: "bucket-readonly",
      name: toolBuckets_0.READ_ONLY.name,
      tools: toolsByBucket.readOnly
    }, {
      id: "bucket-edit",
      name: toolBuckets_0.EDIT.name,
      tools: toolsByBucket.edit
    }, {
      id: "bucket-execution",
      name: toolBuckets_0.EXECUTION.name,
      tools: toolsByBucket.execution
    }, {
      id: "bucket-mcp",
      name: toolBuckets_0.MCP.name,
      tools: toolsByBucket.mcp
    }, {
      id: "bucket-other",
      name: toolBuckets_0.OTHER.name,
      tools: toolsByBucket.other
    }];
    bucketConfigs.forEach(t11 => {
      const {
        id,
        name: name_1,
        tools: bucketTools_0
      } = t11;
      if (bucketTools_0.length === 0) {
        return;
      }
      const selected_0 = count(bucketTools_0, (t_8: Tool) => selectedSet.has(t_8.name));
      const isFullySelected = selected_0 === bucketTools_0.length;
      navigableItems.push({
        id,
        label: `${isFullySelected ? figures.checkboxOn : figures.checkboxOff} ${name_1}`,
        action: createBucketToggleAction(bucketTools_0)
      });
    });
    const toggleButtonIndex = navigableItems.length;
    let t12;
    if ($[40] !== focusIndex || $[41] !== showIndividualTools || $[42] !== toggleButtonIndex) {
      t12 = () => {
        setShowIndividualTools(!showIndividualTools);
        if (showIndividualTools && focusIndex > toggleButtonIndex) {
          setFocusIndex(toggleButtonIndex);
        }
      };
      $[40] = focusIndex;
      $[41] = showIndividualTools;
      $[42] = toggleButtonIndex;
      $[43] = t12;
    } else {
      t12 = $[43];
    }
    navigableItems.push({
      id: "toggle-individual",
      label: showIndividualTools ? "Hide advanced options" : "Show advanced options",
      action: t12,
      isToggle: true
    });
    const mcpServerBuckets = getMcpServerBuckets(customAgentTools);
    if (showIndividualTools) {
      if (mcpServerBuckets.length > 0) {
        navigableItems.push({
          id: "mcp-servers-header",
          label: "MCP Servers:",
          action: _temp6,
          isHeader: true
        });
        mcpServerBuckets.forEach(t13 => {
          const {
            serverName,
            tools: serverTools
          } = t13;
          const selected_1 = count(serverTools, t_9 => selectedSet.has(t_9.name));
          const isFullySelected_0 = selected_1 === serverTools.length;
          navigableItems.push({
            id: `mcp-server-${serverName}`,
            label: `${isFullySelected_0 ? figures.checkboxOn : figures.checkboxOff} ${serverName} (${serverTools.length} ${plural(serverTools.length, "tool")})`,
            action: () => {
              const toolNames_2 = serverTools.map(_temp7);
              handleToggleTools(toolNames_2, !isFullySelected_0);
            }
          });
        });
        navigableItems.push({
          id: "tools-header",
          label: "Individual Tools:",
          action: _temp8,
          isHeader: true
        });
      }
      customAgentTools.forEach(tool_0 => {
        let displayName = tool_0.name;
        if (tool_0.name.startsWith("mcp__")) {
          const mcpInfo = mcpInfoFromString(tool_0.name);
          displayName = mcpInfo ? `${mcpInfo.toolName} (${mcpInfo.serverName})` : tool_0.name;
        }
        navigableItems.push({
          id: `tool-${tool_0.name}`,
          label: `${selectedSet.has(tool_0.name) ? figures.checkboxOn : figures.checkboxOff} ${displayName}`,
          action: () => handleToggleTool(tool_0.name)
        });
      });
    }
    $[24] = createBucketToggleAction;
    $[25] = customAgentTools;
    $[26] = focusIndex;
    $[27] = handleConfirm;
    $[28] = isAllSelected;
    $[29] = selectedSet;
    $[30] = showIndividualTools;
    $[31] = toolsByBucket.edit;
    $[32] = toolsByBucket.execution;
    $[33] = toolsByBucket.mcp;
    $[34] = toolsByBucket.other;
    $[35] = toolsByBucket.readOnly;
    $[36] = navigableItems;
  } else {
    navigableItems = $[36];
  }
  let t10;
  if ($[44] !== initialTools || $[45] !== onCancel || $[46] !== onComplete) {
    t10 = () => {
      if (onCancel) {
        onCancel();
      } else {
        onComplete(initialTools);
      }
    };
    $[44] = initialTools;
    $[45] = onCancel;
    $[46] = onComplete;
    $[47] = t10;
  } else {
    t10 = $[47];
  }
  const handleCancel = t10;
  let t11;
  if ($[48] === Symbol.for("react.memo_cache_sentinel")) {
    t11 = {
      context: "Confirmation"
    };
    $[48] = t11;
  } else {
    t11 = $[48];
  }
  useKeybinding("confirm:no", handleCancel, t11);
  let t12;
  if ($[49] !== focusIndex || $[50] !== navigableItems) {
    t12 = e => {
      if (e.key === "return") {
        e.preventDefault();
        const item = navigableItems[focusIndex];
        if (item && !item.isHeader) {
          item.action();
        }
      } else {
        if (e.key === "up") {
          e.preventDefault();
          let newIndex = focusIndex - 1;
          while (newIndex > 0 && navigableItems[newIndex]?.isHeader) {
            newIndex--;
          }
          setFocusIndex(Math.max(0, newIndex));
        } else {
          if (e.key === "down") {
            e.preventDefault();
            let newIndex_0 = focusIndex + 1;
            while (newIndex_0 < navigableItems.length - 1 && navigableItems[newIndex_0]?.isHeader) {
              newIndex_0++;
            }
            setFocusIndex(Math.min(navigableItems.length - 1, newIndex_0));
          }
        }
      }
    };
    $[49] = focusIndex;
    $[50] = navigableItems;
    $[51] = t12;
  } else {
    t12 = $[51];
  }
  const handleKeyDown = t12;
  const t13 = focusIndex === 0 ? "suggestion" : undefined;
  const t14 = focusIndex === 0;
  const t15 = focusIndex === 0 ? `${figures.pointer} ` : "  ";
  let t16;
  if ($[52] !== t13 || $[53] !== t14 || $[54] !== t15) {
    t16 = <Text color={t13} bold={t14}>{t15}[ Continue ]</Text>;
    $[52] = t13;
    $[53] = t14;
    $[54] = t15;
    $[55] = t16;
  } else {
    t16 = $[55];
  }
  let t17;
  if ($[56] === Symbol.for("react.memo_cache_sentinel")) {
    t17 = <Divider width={40} />;
    $[56] = t17;
  } else {
    t17 = $[56];
  }
  let t18;
  if ($[57] !== navigableItems) {
    t18 = navigableItems.slice(1);
    $[57] = navigableItems;
    $[58] = t18;
  } else {
    t18 = $[58];
  }
  let t19;
  if ($[59] !== focusIndex || $[60] !== t18) {
    t19 = t18.map((item_0, index) => {
      const isCurrentlyFocused = index + 1 === focusIndex;
      const isToggleButton = item_0.isToggle;
      const isHeader = item_0.isHeader;
      return <React.Fragment key={item_0.id}>{isToggleButton && <Divider width={40} />}{isHeader && index > 0 && <Box marginTop={1} />}<Text color={isHeader ? undefined : isCurrentlyFocused ? "suggestion" : undefined} dimColor={isHeader} bold={isToggleButton && isCurrentlyFocused}>{isHeader ? "" : isCurrentlyFocused ? `${figures.pointer} ` : "  "}{isToggleButton ? `[ ${item_0.label} ]` : item_0.label}</Text></React.Fragment>;
    });
    $[59] = focusIndex;
    $[60] = t18;
    $[61] = t19;
  } else {
    t19 = $[61];
  }
  const t20 = isAllSelected ? "All tools selected" : `${selectedSet.size} of ${customAgentTools.length} tools selected`;
  let t21;
  if ($[62] !== t20) {
    t21 = <Box marginTop={1} flexDirection="column"><Text dimColor={true}>{t20}</Text></Box>;
    $[62] = t20;
    $[63] = t21;
  } else {
    t21 = $[63];
  }
  let t22;
  if ($[64] !== handleKeyDown || $[65] !== t16 || $[66] !== t19 || $[67] !== t21) {
    t22 = <Box flexDirection="column" marginTop={1} tabIndex={0} autoFocus={true} onKeyDown={handleKeyDown}>{t16}{t17}{t19}{t21}</Box>;
    $[64] = handleKeyDown;
    $[65] = t16;
    $[66] = t19;
    $[67] = t21;
    $[68] = t22;
  } else {
    t22 = $[68];
  }
  return t22;
}
function _temp8() {}
function _temp7(t_10) {
  return t_10.name;
}
function _temp6() {}
function _temp5(t_7) {
  return t_7.name;
}
function _temp4(t_6) {
  return t_6.name;
}
function _temp3(t_4) {
  return t_4.name;
}
function _temp2(t_0) {
  return t_0.name;
}
function _temp(t) {
  return t.name;
}
