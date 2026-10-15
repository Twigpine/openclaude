import { c as _c } from "react-compiler-runtime";
// Conditionally require()'d in LogoV2.tsx behind feature('KAIROS') ||
// feature('KAIROS_CHANNELS'). No feature() guard here — the whole file
// tree-shakes via the require pattern when both flags are false (see
// docs/feature-gating.md). Do NOT import this module statically from
// unguarded code.

import * as React from 'react';
import { useState } from 'react';
import { type ChannelEntry, getAllowedChannels, getHasDevChannels } from '../../bootstrap/state.js';
import { Box, Text } from '../../ink.js';
import { isChannelsEnabled } from '../../services/mcp/channelAllowlist.js';
import { getEffectiveChannelAllowlist } from '../../services/mcp/channelNotification.js';
import { getMcpConfigsByScope } from '../../services/mcp/config.js';
import { getSubscriptionType } from '../../utils/auth.js';
import { loadInstalledPluginsV2 } from '../../utils/plugins/installedPluginsManager.js';
import { getSettingsForSource } from '../../utils/settings/settings.js';
export function ChannelsNotice() {
  const $ = _c(32);
  const [t0] = useState(_temp);
  const {
    channels,
    disabled,
    noAuth,
    policyBlocked,
    list,
    unmatched
  } = t0;
  if (channels.length === 0) {
    return null;
  }
  const hasNonDev = channels.some(_temp2);
  const flag = getHasDevChannels() && hasNonDev ? "Channels" : getHasDevChannels() ? "--dangerously-load-development-channels" : "--channels";
  if (disabled) {
    let t1;
    if ($[0] !== flag || $[1] !== list) {
      t1 = <Text color="error">{flag} ignored ({list})</Text>;
      $[0] = flag;
      $[1] = list;
      $[2] = t1;
    } else {
      t1 = $[2];
    }
    let t2;
    if ($[3] === Symbol.for("react.memo_cache_sentinel")) {
      t2 = <Text dimColor={true}>Channels are not currently available</Text>;
      $[3] = t2;
    } else {
      t2 = $[3];
    }
    let t3;
    if ($[4] !== t1) {
      t3 = <Box paddingLeft={2} flexDirection="column">{t1}{t2}</Box>;
      $[4] = t1;
      $[5] = t3;
    } else {
      t3 = $[5];
    }
    return t3;
  }
  if (policyBlocked) {
    let t1;
    if ($[12] !== flag || $[13] !== list) {
      t1 = <Text color="error">{flag} blocked by org policy ({list})</Text>;
      $[12] = flag;
      $[13] = list;
      $[14] = t1;
    } else {
      t1 = $[14];
    }
    let t2;
    let t3;
    if ($[15] === Symbol.for("react.memo_cache_sentinel")) {
      t2 = <Text dimColor={true}>Inbound messages will be silently dropped</Text>;
      t3 = <Text dimColor={true}>Have an administrator set channelsEnabled: true in managed settings to enable</Text>;
      $[15] = t2;
      $[16] = t3;
    } else {
      t2 = $[15];
      t3 = $[16];
    }
    let t4;
    if ($[17] !== unmatched) {
      t4 = unmatched.map(_temp3);
      $[17] = unmatched;
      $[18] = t4;
    } else {
      t4 = $[18];
    }
    let t5;
    if ($[19] !== t1 || $[20] !== t4) {
      t5 = <Box paddingLeft={2} flexDirection="column">{t1}{t2}{t3}{t4}</Box>;
      $[19] = t1;
      $[20] = t4;
      $[21] = t5;
    } else {
      t5 = $[21];
    }
    return t5;
  }
  let t1;
  if ($[22] !== list) {
    t1 = <Text color="error">Listening for channel messages from: {list}</Text>;
    $[22] = list;
    $[23] = t1;
  } else {
    t1 = $[23];
  }
  let t2;
  if ($[24] !== flag) {
    t2 = <Text dimColor={true}>Experimental · inbound messages will be pushed into this session, this carries prompt injection risks. Restart OpenClaude without {flag} to disable.</Text>;
    $[24] = flag;
    $[25] = t2;
  } else {
    t2 = $[25];
  }
  let t3;
  if ($[26] !== unmatched) {
    t3 = unmatched.map(_temp4);
    $[26] = unmatched;
    $[27] = t3;
  } else {
    t3 = $[27];
  }
  let t4;
  if ($[28] !== t1 || $[29] !== t2 || $[30] !== t3) {
    t4 = <Box paddingLeft={2} flexDirection="column">{t1}{t2}{t3}</Box>;
    $[28] = t1;
    $[29] = t2;
    $[30] = t3;
    $[31] = t4;
  } else {
    t4 = $[31];
  }
  return t4;
}
function _temp4(u_0) {
  return <Text key={`${formatEntry(u_0.entry)}:${u_0.why}`} color="warning">{formatEntry(u_0.entry)} · {u_0.why}</Text>;
}
function _temp3(u) {
  return <Text key={`${formatEntry(u.entry)}:${u.why}`} color="warning">{formatEntry(u.entry)} · {u.why}</Text>;
}
function _temp2(c) {
  return !c.dev;
}
function _temp() {
  const ch = getAllowedChannels();
  if (ch.length === 0) {
    return {
      channels: ch,
      disabled: false,
      noAuth: false,
      policyBlocked: false,
      list: "",
      unmatched: [] as Unmatched[]
    };
  }
  const l = ch.map(formatEntry).join(", ");
  const sub = getSubscriptionType();
  const managed = sub === "team" || sub === "enterprise";
  const policy = getSettingsForSource("policySettings");
  const allowlist = getEffectiveChannelAllowlist(sub, policy?.allowedChannelPlugins);
  return {
    channels: ch,
    disabled: !isChannelsEnabled(),
    noAuth: false,
    policyBlocked: managed && policy?.channelsEnabled !== true,
    list: l,
    unmatched: findUnmatched(ch, allowlist)
  };
}
function formatEntry(c: ChannelEntry): string {
  return c.kind === 'plugin' ? `plugin:${c.name}@${c.marketplace}` : `server:${c.name}`;
}
type Unmatched = {
  entry: ChannelEntry;
  why: string;
};
function findUnmatched(entries: readonly ChannelEntry[], allowlist: ReturnType<typeof getEffectiveChannelAllowlist>): Unmatched[] {
  // Server-kind: build one Set from all scopes up front. getMcpConfigsByScope
  // is not cached (project scope walks the dir tree); getMcpConfigByName would
  // redo that walk per entry.
  const scopes = ['enterprise', 'user', 'project', 'local'] as const;
  const configured = new Set<string>();
  for (const scope of scopes) {
    for (const name of Object.keys(getMcpConfigsByScope(scope).servers)) {
      configured.add(name);
    }
  }

  const installedPluginIds = new Set(Object.keys(loadInstalledPluginsV2().plugins));
  const { entries: allowed, source } = allowlist;

  // Independent ifs — a plugin entry that's both uninstalled AND
  // unlisted shows two lines. Server kind checks config + dev flag.
  const out: Unmatched[] = [];
  for (const entry of entries) {
    if (entry.kind === 'server') {
      if (!configured.has(entry.name)) {
        out.push({
          entry,
          why: 'no MCP server configured with that name'
        });
      }
      continue;
    }
    if (!installedPluginIds.has(`${entry.name}@${entry.marketplace}`)) {
      out.push({
        entry,
        why: 'plugin not installed'
      });
    }
    if (!entry.dev && !allowed.some(e => e.plugin === entry.name && e.marketplace === entry.marketplace)) {
      out.push({
        entry,
        why: source === 'org' ? "not on your org's approved channels list" : 'not on the approved channels allowlist'
      });
    }
  }
  return out;
}
