import { c as _c } from "react-compiler-runtime";
// biome-ignore-all assist/source/organizeImports: internal-only import markers must not be reordered
import * as React from 'react';
import { Box, Text, color } from '../../ink.js';
import { useTerminalSize } from '../../hooks/useTerminalSize.js';
import { stringWidth } from '../../ink/stringWidth.js';
import { getLayoutMode, calculateLayoutDimensions, calculateOptimalLeftWidth, formatWelcomeMessage, truncatePath, getRecentActivitySync, getRecentReleaseNotesSync, getLogoDisplayData } from '../../utils/logoV2Utils.js';
import { truncate } from '../../utils/format.js';
import { getDisplayPath } from '../../utils/file.js';
import { BRAND_TAGLINE } from '../../constants/brand.js';
import { Clawd } from './Clawd.js';
import { WordmarkRow } from './WordmarkRow.js';
import { FeedColumn } from './FeedColumn.js';
import { createRecentActivityFeed, createWhatsNewFeed, createProjectOnboardingFeed, createGuestPassesFeed } from './feedConfigs.js';
import { getGlobalConfig, saveGlobalConfig } from 'src/utils/config.js';
import { resolveThemeSetting } from 'src/utils/systemTheme.js';
import { getInitialSettings } from 'src/utils/settings/settings.js';
import { isDebugMode, isDebugToStdErr, getDebugLogPath } from 'src/utils/debug.js';
import { useEffect, useState } from 'react';
import { getSteps, shouldShowProjectOnboarding, incrementProjectOnboardingSeenCount } from '../../projectOnboardingState.js';
import { CondensedLogo } from './CondensedLogo.js';
import { OffscreenFreeze } from '../OffscreenFreeze.js';
import { checkForReleaseNotesSync } from '../../utils/releaseNotes.js';
import { publicBuildVersion } from '../../utils/version.js';
import { getDumpPromptsPath } from 'src/services/api/dumpPrompts.js';
import { isEnvTruthy } from 'src/utils/envUtils.js';
import { getStartupPerfLogPath, isDetailedProfilingEnabled } from 'src/utils/startupProfiler.js';
import { EmergencyTip } from './EmergencyTip.js';
import { VoiceModeNotice } from './VoiceModeNotice.js';
import { Opus1mMergeNotice } from './Opus1mMergeNotice.js';
import { feature } from 'bun:bundle';

// Conditional require so ChannelsNotice.tsx tree-shakes when both flags are
// false. A module-scope helper component inside a feature() ternary does NOT
// tree-shake (docs/feature-gating.md); the require pattern eliminates the
// whole file. VoiceModeNotice uses the unsafe helper pattern but VOICE_MODE
// is external: true so it's moot there.
/* eslint-disable @typescript-eslint/no-require-imports */
const ChannelsNoticeModule = feature('KAIROS') || feature('KAIROS_CHANNELS') ? require('./ChannelsNotice.js') as typeof import('./ChannelsNotice.js') : null;
/* eslint-enable @typescript-eslint/no-require-imports */
import { SandboxManager } from 'src/utils/sandbox/sandbox-adapter.js';
import { useShowGuestPassesUpsell, incrementGuestPassesSeenCount } from './GuestPassesUpsell.js';
import { useShowOverageCreditUpsell, incrementOverageCreditUpsellSeenCount, createOverageCreditFeed } from './OverageCreditUpsell.js';
import { plural } from '../../utils/stringUtils.js';
import { useAppState } from '../../state/AppState.js';
import { getEffortSuffix } from '../../utils/effort.js';
import { isFirstPartyAnthropicProvider } from '../../utils/model/providers.js';
import { useMainLoopModel } from '../../hooks/useMainLoopModel.js';
import { renderModelSetting } from '../../utils/model/model.js';
// Stubs: internal-only startup notices not included in this open snapshot
// (every render site is gated off with `false &&`).
function GateOverridesWarning(): React.ReactElement | null {
  return null;
}
function ExperimentEnrollmentNotice(): React.ReactElement | null {
  return null;
}
const LEFT_PANEL_MAX_WIDTH = 50;
export function LogoV2() {
  const $ = _c(94);
  const activities = getRecentActivitySync();
  const showAccountIdentity = isFirstPartyAnthropicProvider();
  const username = showAccountIdentity ? getGlobalConfig().oauthAccount?.displayName ?? "" : "";
  const {
    columns
  } = useTerminalSize();
  let t0;
  if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
    t0 = shouldShowProjectOnboarding();
    $[0] = t0;
  } else {
    t0 = $[0];
  }
  const showOnboarding = t0;
  let t1;
  if ($[1] === Symbol.for("react.memo_cache_sentinel")) {
    t1 = SandboxManager.isSandboxingEnabled();
    $[1] = t1;
  } else {
    t1 = $[1];
  }
  const showSandboxStatus = t1;
  const showGuestPassesUpsell = useShowGuestPassesUpsell();
  const showOverageCreditUpsell = useShowOverageCreditUpsell();
  const agent = useAppState(_temp);
  const effortValue = useAppState(_temp2);
  const config = getGlobalConfig();
  let changelog;
  try {
    changelog = getRecentReleaseNotesSync(3);
  } catch {
    changelog = [];
  }
  const [announcement] = useState(() => {
    const announcements = getInitialSettings().companyAnnouncements;
    if (!announcements || announcements.length === 0) {
      return;
    }
    return config.numStartups === 1 ? announcements[0] : announcements[Math.floor(Math.random() * announcements.length)];
  });
  const {
    hasReleaseNotes
  } = checkForReleaseNotesSync(config.lastReleaseNotesSeen);
  let t2;
  if ($[2] === Symbol.for("react.memo_cache_sentinel")) {
    t2 = () => {
      const currentConfig = getGlobalConfig();
      if (currentConfig.lastReleaseNotesSeen === publicBuildVersion) {
        return;
      }
      saveGlobalConfig(_temp3);
      if (showOnboarding) {
        incrementProjectOnboardingSeenCount();
      }
    };
    $[2] = t2;
  } else {
    t2 = $[2];
  }
  let t3;
  if ($[3] !== config) {
    t3 = [config, showOnboarding];
    $[3] = config;
    $[4] = t3;
  } else {
    t3 = $[4];
  }
  useEffect(t2, t3);
  let t4;
  if ($[5] === Symbol.for("react.memo_cache_sentinel")) {
    t4 = !hasReleaseNotes && !showOnboarding && !isEnvTruthy(process.env.CLAUDE_CODE_FORCE_FULL_LOGO);
    $[5] = t4;
  } else {
    t4 = $[5];
  }
  const isCondensedMode = t4;
  let t5;
  let t6;
  if ($[6] !== showGuestPassesUpsell) {
    t5 = () => {
      if (showGuestPassesUpsell && !showOnboarding && !isCondensedMode) {
        incrementGuestPassesSeenCount();
      }
    };
    t6 = [showGuestPassesUpsell, showOnboarding, isCondensedMode];
    $[6] = showGuestPassesUpsell;
    $[7] = t5;
    $[8] = t6;
  } else {
    t5 = $[7];
    t6 = $[8];
  }
  useEffect(t5, t6);
  let t7;
  let t8;
  if ($[9] !== showGuestPassesUpsell || $[10] !== showOverageCreditUpsell) {
    t7 = () => {
      if (showOverageCreditUpsell && !showOnboarding && !showGuestPassesUpsell && !isCondensedMode) {
        incrementOverageCreditUpsellSeenCount();
      }
    };
    t8 = [showOverageCreditUpsell, showOnboarding, showGuestPassesUpsell, isCondensedMode];
    $[9] = showGuestPassesUpsell;
    $[10] = showOverageCreditUpsell;
    $[11] = t7;
    $[12] = t8;
  } else {
    t7 = $[11];
    t8 = $[12];
  }
  useEffect(t7, t8);
  const model = useMainLoopModel();
  const fullModelDisplayName = renderModelSetting(model);
  const {
    version,
    cwd,
    billingType,
    agentName: agentNameFromSettings
  } = getLogoDisplayData();
  const agentName = agent ?? agentNameFromSettings;
  const effortSuffix = getEffortSuffix(model, effortValue);
  const t9 = fullModelDisplayName + effortSuffix;
  let t10;
  if ($[13] !== t9) {
    t10 = truncate(t9, LEFT_PANEL_MAX_WIDTH - 20);
    $[13] = t9;
    $[14] = t10;
  } else {
    t10 = $[14];
  }
  const modelDisplayName = t10;
  if (!hasReleaseNotes && !showOnboarding && !isEnvTruthy(process.env.CLAUDE_CODE_FORCE_FULL_LOGO)) {
    let t11;
    let t12;
    let t13;
    let t14;
    let t15;
    let t16;
    let t17;
    if ($[15] === Symbol.for("react.memo_cache_sentinel")) {
      t11 = <CondensedLogo />;
      t12 = <VoiceModeNotice />;
      t13 = <Opus1mMergeNotice />;
      t14 = ChannelsNoticeModule && <ChannelsNoticeModule.ChannelsNotice />;
      t15 = isDebugMode() && <Box paddingLeft={2} flexDirection="column"><Text color="warning">Debug mode enabled</Text><Text dimColor={true}>Logging to: {isDebugToStdErr() ? "stderr" : getDebugLogPath()}</Text></Box>;
      t16 = <EmergencyTip />;
      t17 = process.env.CLAUDE_CODE_TMUX_SESSION && <Box paddingLeft={2} flexDirection="column"><Text dimColor={true}>tmux session: {process.env.CLAUDE_CODE_TMUX_SESSION}</Text><Text dimColor={true}>{process.env.CLAUDE_CODE_TMUX_PREFIX_CONFLICTS ? `Detach: ${process.env.CLAUDE_CODE_TMUX_PREFIX} ${process.env.CLAUDE_CODE_TMUX_PREFIX} d (press prefix twice - Claude uses ${process.env.CLAUDE_CODE_TMUX_PREFIX})` : `Detach: ${process.env.CLAUDE_CODE_TMUX_PREFIX} d`}</Text></Box>;
      $[15] = t11;
      $[16] = t12;
      $[17] = t13;
      $[18] = t14;
      $[19] = t15;
      $[20] = t16;
      $[21] = t17;
    } else {
      t11 = $[15];
      t12 = $[16];
      t13 = $[17];
      t14 = $[18];
      t15 = $[19];
      t16 = $[20];
      t17 = $[21];
    }
    let t18;
    if ($[22] !== announcement || $[23] !== config) {
      t18 = announcement && <Box paddingLeft={2} flexDirection="column">{showAccountIdentity && !process.env.IS_DEMO && config.oauthAccount?.organizationName && <Text dimColor={true}>Message from {config.oauthAccount.organizationName}:</Text>}<Text>{announcement}</Text></Box>;
      $[22] = announcement;
      $[23] = config;
      $[24] = t18;
    } else {
      t18 = $[24];
    }
    let t19;
    let t20;
    let t21;
    let t22;
    if ($[25] === Symbol.for("react.memo_cache_sentinel")) {
      t19 = false && !process.env.DEMO_VERSION && <Box paddingLeft={2} flexDirection="column"><Text dimColor={true}>Use /issue to report model behavior issues</Text></Box>;
      t20 = false && !process.env.DEMO_VERSION && <Box paddingLeft={2} flexDirection="column"><Text color="warning">[internal] Logs:</Text><Text dimColor={true}>API calls: {getDisplayPath(getDumpPromptsPath())}</Text><Text dimColor={true}>Debug logs: {getDisplayPath(getDebugLogPath())}</Text>{isDetailedProfilingEnabled() && <Text dimColor={true}>Startup Perf: {getDisplayPath(getStartupPerfLogPath())}</Text>}</Box>;
      t21 = false && <GateOverridesWarning />;
      t22 = false && <ExperimentEnrollmentNotice />;
      $[25] = t19;
      $[26] = t20;
      $[27] = t21;
      $[28] = t22;
    } else {
      t19 = $[25];
      t20 = $[26];
      t21 = $[27];
      t22 = $[28];
    }
    let t23;
    if ($[29] !== t18) {
      t23 = <>{t11}{t12}{t13}{t14}{t15}{t16}{t17}{t18}{t19}{t20}{t21}{t22}</>;
      $[29] = t18;
      $[30] = t23;
    } else {
      t23 = $[30];
    }
    return t23;
  }
  const layoutMode = getLayoutMode(columns);
  const userTheme = resolveThemeSetting(getGlobalConfig().theme);
  const borderTitle = ` ${color("text", userTheme)("OpenClaude")} ${color("inactive", userTheme)(`v${version}`)} `;
  const compactBorderTitle = color("text", userTheme)(" OpenClaude ");
  if (layoutMode === "compact") {
    let welcomeMessage = formatWelcomeMessage(username);
    if (stringWidth(welcomeMessage) > columns - 4) {
      let t11;
      if ($[31] === Symbol.for("react.memo_cache_sentinel")) {
        t11 = formatWelcomeMessage(null);
        $[31] = t11;
      } else {
        t11 = $[31];
      }
      welcomeMessage = t11;
    }
    const cwdAvailableWidth = agentName ? columns - 4 - 1 - stringWidth(agentName) - 3 : columns - 4;
    const truncatedCwd = truncatePath(cwd, Math.max(cwdAvailableWidth, 10));
    let t11;
    if ($[32] !== compactBorderTitle) {
      t11 = {
        content: compactBorderTitle,
        position: "top",
        align: "start",
        offset: 1
      };
      $[32] = compactBorderTitle;
      $[33] = t11;
    } else {
      t11 = $[33];
    }
    let t12;
    if ($[34] === Symbol.for("react.memo_cache_sentinel")) {
      t12 = <Box marginY={1}><Clawd /></Box>;
      $[34] = t12;
    } else {
      t12 = $[34];
    }
    let t13;
    if ($[35] !== modelDisplayName) {
      t13 = <Text dimColor={true}>{modelDisplayName}</Text>;
      $[35] = modelDisplayName;
      $[36] = t13;
    } else {
      t13 = $[36];
    }
    let t14;
    let t15;
    let t16;
    if ($[37] === Symbol.for("react.memo_cache_sentinel")) {
      t14 = <VoiceModeNotice />;
      t15 = <Opus1mMergeNotice />;
      t16 = ChannelsNoticeModule && <ChannelsNoticeModule.ChannelsNotice />;
      $[37] = t14;
      $[38] = t15;
      $[39] = t16;
    } else {
      t14 = $[37];
      t15 = $[38];
      t16 = $[39];
    }
    let t17;
    if ($[40] !== showSandboxStatus) {
      t17 = showSandboxStatus && <Box marginTop={1} flexDirection="column"><Text color="warning">Your bash commands will be sandboxed. Disable with /sandbox.</Text></Box>;
      $[40] = showSandboxStatus;
      $[41] = t17;
    } else {
      t17 = $[41];
    }
    let t18;
    let t19;
    if ($[42] === Symbol.for("react.memo_cache_sentinel")) {
      t18 = false && <GateOverridesWarning />;
      t19 = false && <ExperimentEnrollmentNotice />;
      $[42] = t18;
      $[43] = t19;
    } else {
      t18 = $[42];
      t19 = $[43];
    }
    return <><OffscreenFreeze><Box flexDirection="column" borderStyle="round" borderColor="inactive" borderText={t11} paddingX={1} paddingY={1} alignItems="center" width={columns}><Text bold={true}>{welcomeMessage}</Text>{t12}{t13}<Text dimColor={true}>{billingType}</Text><Text dimColor={true}>{agentName ? `@${agentName} · ${truncatedCwd}` : truncatedCwd}</Text></Box></OffscreenFreeze>{t14}{t15}{t16}{t17}{t18}{t19}</>;
  }
  const welcomeMessage_0 = formatWelcomeMessage(username);
  const modelLine = showAccountIdentity && !process.env.IS_DEMO && config.oauthAccount?.organizationName ? `${modelDisplayName} · ${billingType} · ${config.oauthAccount.organizationName}` : `${modelDisplayName} · ${billingType}`;
  const cwdAvailableWidth_0 = agentName ? LEFT_PANEL_MAX_WIDTH - 1 - stringWidth(agentName) - 3 : LEFT_PANEL_MAX_WIDTH;
  const truncatedCwd_0 = truncatePath(cwd, Math.max(cwdAvailableWidth_0, 10));
  const cwdLine = agentName ? `@${agentName} · ${truncatedCwd_0}` : truncatedCwd_0;
  const optimalLeftWidth = calculateOptimalLeftWidth(welcomeMessage_0, cwdLine, modelLine);
  const {
    leftWidth,
    rightWidth
  } = calculateLayoutDimensions(columns, layoutMode, optimalLeftWidth);
  const T0 = OffscreenFreeze;
  const T1 = Box;
  const t11 = "column";
  const t12 = "round";
  const t13 = "inactive";
  let t14;
  if ($[44] !== borderTitle) {
    t14 = {
      content: borderTitle,
      position: "top",
      align: "start",
      offset: 3
    };
    $[44] = borderTitle;
    $[45] = t14;
  } else {
    t14 = $[45];
  }
  const T2 = Box;
  const t15 = "column";
  const t16 = 0;
  const t17 = 1;
  let t18;
  if ($[46] !== welcomeMessage_0) {
    t18 = <Box marginTop={1} flexDirection="column" alignItems="center"><WordmarkRow /><Text dimColor={true}>{BRAND_TAGLINE}</Text><Text color="inactive">•</Text><Text bold={true}>{welcomeMessage_0}</Text></Box>;
    $[46] = welcomeMessage_0;
    $[47] = t18;
  } else {
    t18 = $[47];
  }
  let t19;
  if ($[48] === Symbol.for("react.memo_cache_sentinel")) {
    t19 = <Clawd />;
    $[48] = t19;
  } else {
    t19 = $[48];
  }
  let t20;
  if ($[49] !== modelLine) {
    t20 = <Text><Text color="inactive">Model</Text><Text dimColor={true}>  {modelLine}</Text></Text>;
    $[49] = modelLine;
    $[50] = t20;
  } else {
    t20 = $[50];
  }
  let t21;
  if ($[51] !== cwdLine) {
    t21 = <Text><Text color="inactive">Path</Text><Text dimColor={true}>   {cwdLine}</Text></Text>;
    $[51] = cwdLine;
    $[52] = t21;
  } else {
    t21 = $[52];
  }
  let t22;
  if ($[53] !== t20 || $[54] !== t21) {
    t22 = <Box flexDirection="column" alignItems="center"><Text dimColor={true}>────────────</Text>{t20}{t21}</Box>;
    $[53] = t20;
    $[54] = t21;
    $[55] = t22;
  } else {
    t22 = $[55];
  }
  let t23;
  if ($[56] !== columns || $[57] !== t18 || $[58] !== t22) {
    t23 = <Box flexDirection="column" width="100%" justifyContent="center" alignItems="center" minHeight={11}><Box borderStyle="round" borderColor="inactive" paddingX={3} paddingY={1} width="100%" justifyContent="center" alignItems="center" minHeight={11}><Box flexDirection="column" alignItems="center" justifyContent="center">{t18}<Box marginY={1}>{t19}</Box>{t22}</Box></Box></Box>;
    $[56] = columns;
    $[57] = t18;
    $[58] = t22;
    $[59] = t23;
  } else {
    t23 = $[59];
  }
  let t24;
  if ($[60] !== layoutMode) {
    t24 = false;
    $[60] = layoutMode;
    $[61] = t24;
  } else {
    t24 = $[61];
  }
  const t25 = <FeedColumn feeds={showOnboarding ? [createProjectOnboardingFeed(getSteps()), createRecentActivityFeed(activities)] : showGuestPassesUpsell ? [createRecentActivityFeed(activities), createGuestPassesFeed()] : showOverageCreditUpsell ? [createRecentActivityFeed(activities), createOverageCreditFeed()] : [createRecentActivityFeed(activities), createWhatsNewFeed(changelog)]} maxWidth={columns - 4} />;
  let t26;
  if ($[62] !== T2 || $[63] !== t15 || $[64] !== t23 || $[65] !== t24 || $[66] !== t25) {
    t26 = <T2 flexDirection={t15} paddingX={t16} gap={t17}>{t23}{t24}{t25}</T2>;
    $[62] = T2;
    $[63] = t15;
    $[64] = t23;
    $[65] = t24;
    $[66] = t25;
    $[67] = t26;
  } else {
    t26 = $[67];
  }
  let t27;
  if ($[68] !== T1 || $[69] !== t14 || $[70] !== t26) {
    t27 = <T1 flexDirection={t11} borderStyle={t12} borderColor={t13} borderText={t14}>{t26}</T1>;
    $[68] = T1;
    $[69] = t14;
    $[70] = t26;
    $[71] = t27;
  } else {
    t27 = $[71];
  }
  let t28;
  if ($[72] !== T0 || $[73] !== t27) {
    t28 = <T0>{t27}</T0>;
    $[72] = T0;
    $[73] = t27;
    $[74] = t28;
  } else {
    t28 = $[74];
  }
  let t29;
  let t30;
  let t31;
  let t32;
  let t33;
  let t34;
  if ($[75] === Symbol.for("react.memo_cache_sentinel")) {
    t29 = <VoiceModeNotice />;
    t30 = <Opus1mMergeNotice />;
    t31 = ChannelsNoticeModule && <ChannelsNoticeModule.ChannelsNotice />;
    t32 = isDebugMode() && <Box paddingLeft={2} flexDirection="column"><Text color="warning">Debug mode enabled</Text><Text dimColor={true}>Logging to: {isDebugToStdErr() ? "stderr" : getDebugLogPath()}</Text></Box>;
    t33 = <EmergencyTip />;
    t34 = process.env.CLAUDE_CODE_TMUX_SESSION && <Box paddingLeft={2} flexDirection="column"><Text dimColor={true}>tmux session: {process.env.CLAUDE_CODE_TMUX_SESSION}</Text><Text dimColor={true}>{process.env.CLAUDE_CODE_TMUX_PREFIX_CONFLICTS ? `Detach: ${process.env.CLAUDE_CODE_TMUX_PREFIX} ${process.env.CLAUDE_CODE_TMUX_PREFIX} d (press prefix twice - Claude uses ${process.env.CLAUDE_CODE_TMUX_PREFIX})` : `Detach: ${process.env.CLAUDE_CODE_TMUX_PREFIX} d`}</Text></Box>;
    $[75] = t29;
    $[76] = t30;
    $[77] = t31;
    $[78] = t32;
    $[79] = t33;
    $[80] = t34;
  } else {
    t29 = $[75];
    t30 = $[76];
    t31 = $[77];
    t32 = $[78];
    t33 = $[79];
    t34 = $[80];
  }
  let t35;
  if ($[81] !== announcement || $[82] !== config) {
    t35 = announcement && <Box paddingLeft={2} flexDirection="column">{showAccountIdentity && !process.env.IS_DEMO && config.oauthAccount?.organizationName && <Text dimColor={true}>Message from {config.oauthAccount.organizationName}:</Text>}<Text>{announcement}</Text></Box>;
    $[81] = announcement;
    $[82] = config;
    $[83] = t35;
  } else {
    t35 = $[83];
  }
  let t36;
  if ($[84] !== showSandboxStatus) {
    t36 = showSandboxStatus && <Box paddingLeft={2} flexDirection="column"><Text color="warning">Your bash commands will be sandboxed. Disable with /sandbox.</Text></Box>;
    $[84] = showSandboxStatus;
    $[85] = t36;
  } else {
    t36 = $[85];
  }
  let t37;
  let t38;
  let t39;
  let t40;
  if ($[86] === Symbol.for("react.memo_cache_sentinel")) {
    t37 = false && !process.env.DEMO_VERSION && <Box paddingLeft={2} flexDirection="column"><Text dimColor={true}>Use /issue to report model behavior issues</Text></Box>;
    t38 = false && !process.env.DEMO_VERSION && <Box paddingLeft={2} flexDirection="column"><Text color="warning">[internal] Logs:</Text><Text dimColor={true}>API calls: {getDisplayPath(getDumpPromptsPath())}</Text><Text dimColor={true}>Debug logs: {getDisplayPath(getDebugLogPath())}</Text>{isDetailedProfilingEnabled() && <Text dimColor={true}>Startup Perf: {getDisplayPath(getStartupPerfLogPath())}</Text>}</Box>;
    t39 = false && <GateOverridesWarning />;
    t40 = false && <ExperimentEnrollmentNotice />;
    $[86] = t37;
    $[87] = t38;
    $[88] = t39;
    $[89] = t40;
  } else {
    t37 = $[86];
    t38 = $[87];
    t39 = $[88];
    t40 = $[89];
  }
  let t41;
  if ($[90] !== t28 || $[91] !== t35 || $[92] !== t36) {
    t41 = <>{t28}{t29}{t30}{t31}{t32}{t33}{t34}{t35}{t36}{t37}{t38}{t39}{t40}</>;
    $[90] = t28;
    $[91] = t35;
    $[92] = t36;
    $[93] = t41;
  } else {
    t41 = $[93];
  }
  return t41;
}
function _temp3(current) {
  if (current.lastReleaseNotesSeen === publicBuildVersion) {
    return current;
  }
  return {
    ...current,
    lastReleaseNotesSeen: publicBuildVersion
  };
}
function _temp2(s_0) {
  return s_0.effortValue;
}
function _temp(s) {
  return s.agent;
}
