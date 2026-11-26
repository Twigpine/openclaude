import { c as _c } from "react-compiler-runtime";
import figures from 'figures';
import type { RefObject } from 'react';
import React, { useCallback, useMemo, useRef } from 'react';
import { Box, Text } from '../ink.js';
import { useKeybindings } from '../keybindings/useKeybinding.js';
import { logEvent } from '../services/analytics/index.js';
import { REPL_TOOL_NAME } from '../tools/REPLTool/constants.js';
import type { NormalizedUserMessage, RenderableMessage } from '../types/message.js';
import { getToolUseID, isEmptyMessageText, SYNTHETIC_MESSAGES } from '../utils/messages.js';
const NAVIGABLE_TYPES = ['user', 'assistant', 'grouped_tool_use', 'collapsed_read_search', 'system', 'attachment'] as const;
export type NavigableType = (typeof NAVIGABLE_TYPES)[number];
export type NavigableOf<T extends NavigableType> = Extract<RenderableMessage, {
  type: T;
}>;
export type NavigableMessage = RenderableMessage;

// Tier-2 blocklist (tier-1 is height > 0) — things that render but aren't actionable.
export function isNavigableMessage(msg: NavigableMessage): boolean {
  switch (msg.type) {
    case 'assistant':
      {
        const b = msg.message.content[0];
        // Text responses (minus AssistantTextMessage's return-null cases — tier-1
        // misses unmeasured virtual items), or tool calls with extractable input.
        return b?.type === 'text' && !isEmptyMessageText(b.text) && !SYNTHETIC_MESSAGES.has(b.text) || b?.type === 'tool_use' && b.name in PRIMARY_INPUT;
      }
    case 'user':
      {
        if (msg.isMeta || msg.isCompactSummary) return false;
        const b = msg.message.content[0];
        if (b?.type !== 'text') return false;
        // Interrupt etc. — synthetic, not user-authored.
        if (SYNTHETIC_MESSAGES.has(b.text)) return false;
        // Same filter as VirtualMessageList sticky-prompt: XML-wrapped (command
        // expansions, bash-stdout, etc.) aren't real prompts.
        return !stripSystemReminders(b.text).startsWith('<');
      }
    case 'system':
      // biome-ignore lint/nursery/useExhaustiveSwitchCases: blocklist — fallthrough return-true is the design
      switch (msg.subtype) {
        case 'api_metrics':
        case 'stop_hook_summary':
        case 'turn_duration':
        case 'memory_saved':
        case 'agents_killed':
        case 'away_summary':
        case 'thinking':
        case 'focus_marker':
        case 'focus_summary':
          return false;
      }
      return true;
    case 'grouped_tool_use':
    case 'collapsed_read_search':
      return true;
    case 'attachment':
      switch (msg.attachment.type) {
        case 'queued_command':
        case 'diagnostics':
        case 'hook_blocking_error':
        case 'hook_error_during_execution':
          return true;
      }
      return false;
  }
}
type PrimaryInput = {
  label: string;
  extract: (input: Record<string, unknown>) => string | undefined;
};
const str = (k: string) => (i: Record<string, unknown>) => typeof i[k] === 'string' ? i[k] : undefined;
const PRIMARY_INPUT: Record<string, PrimaryInput> = {
  Read: {
    label: 'path',
    extract: str('file_path')
  },
  Edit: {
    label: 'path',
    extract: str('file_path')
  },
  Write: {
    label: 'path',
    extract: str('file_path')
  },
  NotebookEdit: {
    label: 'path',
    extract: str('notebook_path')
  },
  Bash: {
    label: 'command',
    extract: str('command')
  },
  [REPL_TOOL_NAME]: {
    label: 'code',
    extract: str('code')
  },
  Grep: {
    label: 'pattern',
    extract: str('pattern')
  },
  Glob: {
    label: 'pattern',
    extract: str('pattern')
  },
  WebFetch: {
    label: 'url',
    extract: str('url')
  },
  WebSearch: {
    label: 'query',
    extract: str('query')
  },
  Task: {
    label: 'prompt',
    extract: str('prompt')
  },
  Agent: {
    label: 'prompt',
    extract: str('prompt')
  },
  Tmux: {
    label: 'command',
    extract: i => Array.isArray(i.args) ? `tmux ${i.args.join(' ')}` : undefined
  }
};

// Only AgentTool has renderGroupedToolUse — Edit/Bash/etc. stay as assistant tool_use blocks.
export function toolCallOf(msg: NavigableMessage): {
  name: string;
  input: Record<string, unknown>;
} | undefined {
  if (msg.type === 'assistant') {
    const b = msg.message.content[0];
    if (b?.type === 'tool_use') return {
      name: b.name,
      input: b.input as Record<string, unknown>
    };
  }
  if (msg.type === 'grouped_tool_use') {
    const b = msg.messages[0]?.message.content[0];
    if (b?.type === 'tool_use') return {
      name: msg.toolName,
      input: b.input as Record<string, unknown>
    };
  }
  return undefined;
}
export function primaryInputOf(msg: NavigableMessage): string | undefined {
  const tc = toolCallOf(msg);
  return tc ? PRIMARY_INPUT[tc.name]?.extract(tc.input) : undefined;
}

/** Key shared by a tool_use and its tool_result so expansion toggles both. */
export function messageExpandKey(msg: NavigableMessage): string {
  return (msg.type === 'assistant' || msg.type === 'user' ? getToolUseID(msg) : null) ?? msg.uuid;
}

export type MessageActionCaps = {
  copy: (text: string) => void;
  edit: (msg: NormalizedUserMessage) => Promise<void>;
};

// Identity builder — preserves tuple type so `run`'s param narrows (array literal widens without this).
function action<const T extends NavigableType, const K extends string>(a: {
  key: K;
  label: string | ((s: MessageActionsState) => string);
  types: readonly T[];
  applies?: (s: MessageActionsState) => boolean;
  stays?: true;
  run: (m: NavigableOf<T>, caps: MessageActionCaps) => void;
}) {
  return a;
}
export const MESSAGE_ACTIONS = [action({
  key: 'enter',
  label: s => {
    if (s.expanded) return 'to collapse';
    if (s.toolName === REPL_TOOL_NAME && s.primaryInputLineCount !== undefined) {
      return `to show ${s.primaryInputLineCount} ${s.primaryInputLineCount === 1 ? 'line' : 'lines'}`;
    }
    return 'expand';
  },
  types: ['assistant', 'grouped_tool_use', 'collapsed_read_search', 'attachment', 'system'],
  applies: s => s.msgType !== 'assistant' || s.toolName === REPL_TOOL_NAME,
  stays: true,
  // Empty — `stays` handled inline by dispatch.
  run: () => {}
}), action({
  key: 'enter',
  label: 'edit',
  types: ['user'],
  run: (m, c) => void c.edit(m)
}), action({
  key: 'c',
  label: 'copy',
  types: NAVIGABLE_TYPES,
  run: (m, c) => c.copy(copyTextOf(m))
}), action({
  key: 'p',
  // `!` safe: applies() guarantees toolName ∈ PRIMARY_INPUT.
  label: s => `copy ${PRIMARY_INPUT[s.toolName!]!.label}`,
  types: ['grouped_tool_use', 'assistant'],
  applies: s => s.toolName != null && s.toolName in PRIMARY_INPUT,
  run: (m, c) => {
    const tc = toolCallOf(m);
    if (!tc) return;
    const val = PRIMARY_INPUT[tc.name]?.extract(tc.input);
    if (val) c.copy(val);
  }
})] as const;
function isApplicable(a: (typeof MESSAGE_ACTIONS)[number], c: MessageActionsState): boolean {
  if (!(a.types as readonly string[]).includes(c.msgType)) return false;
  return !a.applies || a.applies(c);
}
export type MessageActionsState = {
  uuid: string;
  msgType: NavigableType;
  expanded: boolean;
  expandKey: string;
  toolName?: string;
  primaryInputLineCount?: number;
};
export type MessageActionsNav = {
  enterCursor: () => void;
  navigatePrev: () => void;
  navigateNext: () => void;
  navigatePrevUser: () => void;
  navigateNextUser: () => void;
  navigateTop: () => void;
  navigateBottom: () => void;
  getSelected: () => NavigableMessage | null;
};
export const MessageActionsSelectedContext = React.createContext(false);
export const InVirtualListContext = React.createContext(false);

// bg must go on the Box that HAS marginTop (margin stays outside paint) — that's inside each consumer.
export function useSelectedMessageBg() {
  return React.useContext(MessageActionsSelectedContext) ? "messageActionsBackground" : undefined;
}

// Can't call useKeybindings here — hook runs outside <KeybindingSetup> provider. Returns handlers instead.
export function useMessageActions(cursor: MessageActionsState | null, setCursor: React.Dispatch<React.SetStateAction<MessageActionsState | null>>, navRef: RefObject<MessageActionsNav | null>, caps: MessageActionCaps): {
  enter: () => void;
  handlers: Record<string, () => void>;
} {
  // Refs keep handlers stable — no useKeybindings re-register per message append.
  const cursorRef = useRef(cursor);
  cursorRef.current = cursor;
  const capsRef = useRef(caps);
  capsRef.current = caps;
  const handlers = useMemo(() => {
    const h: Record<string, () => void> = {
      'messageActions:prev': () => navRef.current?.navigatePrev(),
      'messageActions:next': () => navRef.current?.navigateNext(),
      'messageActions:prevUser': () => navRef.current?.navigatePrevUser(),
      'messageActions:nextUser': () => navRef.current?.navigateNextUser(),
      'messageActions:top': () => navRef.current?.navigateTop(),
      'messageActions:bottom': () => navRef.current?.navigateBottom(),
      'messageActions:escape': () => setCursor(c => c?.expanded ? {
        ...c,
        expanded: false
      } : null),
      // ctrl+c skips the collapse step — from expanded-during-streaming, two-stage
      // would mean 3 presses to interrupt (collapse→null→cancel).
      'messageActions:ctrlc': () => setCursor(null)
    };
    for (const key of new Set(MESSAGE_ACTIONS.map(a_1 => a_1.key))) {
      h[`messageActions:${key}`] = () => {
        const c_0 = cursorRef.current;
        if (!c_0) return;
        const a_0 = MESSAGE_ACTIONS.find(a => a.key === key && isApplicable(a, c_0));
        if (!a_0) return;
        if (a_0.stays) {
          setCursor(c_1 => c_1 ? {
            ...c_1,
            expanded: !c_1.expanded
          } : null);
          return;
        }
        const m = navRef.current?.getSelected();
        if (!m) return;
        (a_0.run as (m: NavigableMessage, c_0: MessageActionCaps) => void)(m, capsRef.current);
        setCursor(null);
      };
    }
    return h;
  }, [setCursor, navRef]);
  const enter = useCallback(() => {
    logEvent('tengu_message_actions_enter', {});
    navRef.current?.enterCursor();
  }, [navRef]);
  return {
    enter,
    handlers
  };
}

// Must mount inside <KeybindingSetup>.
export function MessageActionsKeybindings(t0) {
  const $ = _c(2);
  const {
    handlers,
    isActive
  } = t0;
  let t1;
  if ($[0] !== isActive) {
    t1 = {
      context: "MessageActions",
      isActive
    };
    $[0] = isActive;
    $[1] = t1;
  } else {
    t1 = $[1];
  }
  useKeybindings(handlers, t1);
  return null;
}

// borderTop-only Box matches PromptInput's ─── line for stable footer height.
export function MessageActionsBar(t0) {
  const $ = _c(28);
  const {
    cursor
  } = t0;
  let T0;
  let T1;
  let t1;
  let t2;
  let t3;
  let t4;
  let t5;
  let t6;
  let t7;
  if ($[0] !== cursor) {
    const applicable = MESSAGE_ACTIONS.filter(a => isApplicable(a, cursor));
    T1 = Box;
    t4 = "column";
    t5 = 0;
    t6 = 1;
    if ($[10] === Symbol.for("react.memo_cache_sentinel")) {
      t7 = <Box borderStyle="single" borderTop={true} borderBottom={false} borderLeft={false} borderRight={false} borderDimColor={true} />;
      $[10] = t7;
    } else {
      t7 = $[10];
    }
    T0 = Box;
    t1 = 2;
    t2 = 1;
    t3 = applicable.map((a_0, i) => {
      const label = typeof a_0.label === "function" ? a_0.label(cursor) : a_0.label;
      return <React.Fragment key={a_0.key}>{i > 0 && <Text dimColor={true}> · </Text>}<Text bold={true} dimColor={false}>{a_0.key}</Text><Text dimColor={true}> {label}</Text></React.Fragment>;
    });
    $[0] = cursor;
    $[1] = T0;
    $[2] = T1;
    $[3] = t1;
    $[4] = t2;
    $[5] = t3;
    $[6] = t4;
    $[7] = t5;
    $[8] = t6;
    $[9] = t7;
  } else {
    T0 = $[1];
    T1 = $[2];
    t1 = $[3];
    t2 = $[4];
    t3 = $[5];
    t4 = $[6];
    t5 = $[7];
    t6 = $[8];
    t7 = $[9];
  }
  let t10;
  let t11;
  let t12;
  let t8;
  let t9;
  if ($[11] === Symbol.for("react.memo_cache_sentinel")) {
    t8 = <Text dimColor={true}> · </Text>;
    t9 = <Text bold={true} dimColor={false}>{figures.arrowUp}{figures.arrowDown}</Text>;
    t10 = <Text dimColor={true}> navigate · </Text>;
    t11 = <Text bold={true} dimColor={false}>esc</Text>;
    t12 = <Text dimColor={true}> back</Text>;
    $[11] = t10;
    $[12] = t11;
    $[13] = t12;
    $[14] = t8;
    $[15] = t9;
  } else {
    t10 = $[11];
    t11 = $[12];
    t12 = $[13];
    t8 = $[14];
    t9 = $[15];
  }
  let t13;
  if ($[16] !== T0 || $[17] !== t1 || $[18] !== t2 || $[19] !== t3) {
    t13 = <T0 paddingX={t1} paddingY={t2}>{t3}{t8}{t9}{t10}{t11}{t12}</T0>;
    $[16] = T0;
    $[17] = t1;
    $[18] = t2;
    $[19] = t3;
    $[20] = t13;
  } else {
    t13 = $[20];
  }
  let t14;
  if ($[21] !== T1 || $[22] !== t13 || $[23] !== t4 || $[24] !== t5 || $[25] !== t6 || $[26] !== t7) {
    t14 = <T1 flexDirection={t4} flexShrink={t5} paddingY={t6}>{t7}{t13}</T1>;
    $[21] = T1;
    $[22] = t13;
    $[23] = t4;
    $[24] = t5;
    $[25] = t6;
    $[26] = t7;
    $[27] = t14;
  } else {
    t14 = $[27];
  }
  return t14;
}
export function stripSystemReminders(text: string): string {
  const CLOSE = '</system-reminder>';
  let t = text.trimStart();
  while (t.startsWith('<system-reminder>')) {
    const end = t.indexOf(CLOSE);
    if (end < 0) break;
    t = t.slice(end + CLOSE.length).trimStart();
  }
  return t;
}
export function copyTextOf(msg: NavigableMessage): string {
  switch (msg.type) {
    case 'user':
      {
        const b = msg.message.content[0];
        return b?.type === 'text' ? stripSystemReminders(b.text) : '';
      }
    case 'assistant':
      {
        const b = msg.message.content[0];
        if (b?.type === 'text') return b.text;
        const tc = toolCallOf(msg);
        return tc ? PRIMARY_INPUT[tc.name]?.extract(tc.input) ?? '' : '';
      }
    case 'grouped_tool_use':
      return msg.results.map(toolResultText).filter(Boolean).join('\n\n');
    case 'collapsed_read_search':
      return msg.messages.flatMap(m => m.type === 'user' ? [toolResultText(m)] : m.type === 'grouped_tool_use' ? m.results.map(toolResultText) : []).filter(Boolean).join('\n\n');
    case 'system':
      // content is optional on SystemMessageBase — '' matches the declared
      // string return (previously returned undefined in that edge).
      if ('content' in msg) return msg.content ?? '';
      if ('error' in msg) return String(msg.error);
      return msg.subtype;
    case 'attachment':
      {
        const a = msg.attachment;
        if (a.type === 'queued_command') {
          const p = a.prompt;
          return typeof p === 'string' ? p : p.flatMap(b => b.type === 'text' ? [b.text] : []).join('\n');
        }
        return `[${a.type}]`;
      }
  }
}
function toolResultText(r: NormalizedUserMessage): string {
  const b = r.message.content[0];
  if (b?.type !== 'tool_result') return '';
  const c = b.content;
  if (typeof c === 'string') return c;
  if (!c) return '';
  return c.flatMap(x => x.type === 'text' ? [x.text] : []).join('\n');
}
