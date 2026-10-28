import { c as _c } from "react-compiler-runtime";
import type { ToolUseBlockParam } from '@anthropic-ai/sdk/resources/index.mjs';
import { findToolByName, type Tool, type Tools } from '../../../Tool.js';
import type { buildMessageLookups } from '../../../utils/messages.js';
export function useGetToolFromMessages(toolUseID, tools, lookups) {
  const $ = _c(7);
  let t0;
  if ($[0] !== lookups.toolUseByToolUseID || $[1] !== toolUseID || $[2] !== tools) {
    bb0: {
      const toolUse = lookups.toolUseByToolUseID.get(toolUseID);
      if (!toolUse) {
        t0 = null;
        break bb0;
      }
      const tool = findToolByName(tools, toolUse.name);
      if (!tool) {
        t0 = null;
        break bb0;
      }
      let t1;
      if ($[4] !== tool || $[5] !== toolUse) {
        t1 = {
          tool,
          toolUse
        };
        $[4] = tool;
        $[5] = toolUse;
        $[6] = t1;
      } else {
        t1 = $[6];
      }
      t0 = t1;
    }
    $[0] = lookups.toolUseByToolUseID;
    $[1] = toolUseID;
    $[2] = tools;
    $[3] = t0;
  } else {
    t0 = $[3];
  }
  return t0;
}
