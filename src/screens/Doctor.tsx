import { c as _c } from "react-compiler-runtime";
import figures from 'figures';
import { join } from 'path';
import React, { Suspense, use, useEffect, useMemo, useState } from 'react';
import { KeybindingWarnings } from 'src/components/KeybindingWarnings.js';
import { McpParsingWarnings } from 'src/components/mcp/McpParsingWarnings.js';
import { getModelMaxOutputTokens } from 'src/utils/context.js';
import { getClaudeConfigHomeDir } from 'src/utils/envUtils.js';
import type { SettingSource } from 'src/utils/settings/constants.js';
import { getOriginalCwd } from '../bootstrap/state.js';
import type { CommandResultDisplay } from '../commands.js';
import { Pane } from '../components/design-system/Pane.js';
import { PressEnterToContinue } from '../components/PressEnterToContinue.js';
import { SandboxDoctorSection } from '../components/sandbox/SandboxDoctorSection.js';
import { ValidationErrorsList } from '../components/ValidationErrorsList.js';
import { useSettingsErrors } from '../hooks/notifs/useSettingsErrors.js';
import { useExitOnCtrlCDWithKeybindings } from '../hooks/useExitOnCtrlCDWithKeybindings.js';
import { Box, Text } from '../ink.js';
import { useKeybindings } from '../keybindings/useKeybinding.js';
import { useAppState } from '../state/AppState.js';
import { assembleToolPool } from '../tools.js';
import type { Tools } from '../Tool.js';
import { getPluginErrorMessage } from '../types/plugin.js';
import { getGcsDistTags, getNpmDistTags, type NpmDistTags } from '../utils/autoUpdater.js';
import { type ContextWarnings, checkContextWarnings } from '../utils/doctorContextWarnings.js';
import { buildLocalModelContextLoad, isActiveProviderLocalModel } from '../utils/statusNoticeLocalModel.js';
import { type DiagnosticInfo, getDoctorDiagnostic } from '../utils/doctorDiagnostic.js';
import { validateBoundedIntEnvVar } from '../utils/envValidation.js';
import { pathExists } from '../utils/file.js';
import { cleanupStaleLocks, getAllLockInfo, isPidBasedLockingEnabled, type LockInfo } from '../utils/nativeInstaller/pidLock.js';
import { getInitialSettings } from '../utils/settings/settings.js';
import { BASH_MAX_OUTPUT_DEFAULT, BASH_MAX_OUTPUT_UPPER_LIMIT } from '../utils/shell/outputLimits.js';
import { TASK_MAX_OUTPUT_DEFAULT, TASK_MAX_OUTPUT_UPPER_LIMIT } from '../utils/task/outputFormatting.js';
import { getXDGStateHome } from '../utils/xdg.js';
import { loadDoctorDiagnostic } from './doctorDiagnosticLoad.js';
import { resolveDoctorDistTags } from './doctorDistTags.js';
type Props = {
  onDone: (result?: string, options?: {
    display?: CommandResultDisplay;
  }) => void;
};
type AgentInfo = {
  activeAgents: Array<{
    agentType: string;
    source: SettingSource | 'built-in' | 'plugin';
  }>;
  userAgentsDir: string;
  projectAgentsDir: string;
  userDirExists: boolean;
  projectDirExists: boolean;
  failedFiles?: Array<{
    path: string;
    error: string;
  }>;
};
type VersionLockInfo = {
  enabled: boolean;
  locks: LockInfo[];
  locksDir: string;
  staleLocksCleaned: number;
};
function DistTagsDisplay(t0: {
  promise: Promise<NpmDistTags>;
}) {
  const $ = _c(8);
  const {
    promise
  } = t0;
  const distTags = use(promise);
  if (!distTags.latest) {
    let t1;
    if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
      t1 = <Text dimColor={true}>└ Failed to fetch versions</Text>;
      $[0] = t1;
    } else {
      t1 = $[0];
    }
    return t1;
  }
  let t1;
  if ($[1] !== distTags.stable) {
    t1 = distTags.stable && <Text>└ Stable version: {distTags.stable}</Text>;
    $[1] = distTags.stable;
    $[2] = t1;
  } else {
    t1 = $[2];
  }
  let t2;
  if ($[3] !== distTags.latest) {
    t2 = <Text>└ Latest version: {distTags.latest}</Text>;
    $[3] = distTags.latest;
    $[4] = t2;
  } else {
    t2 = $[4];
  }
  let t3;
  if ($[5] !== t1 || $[6] !== t2) {
    t3 = <>{t1}{t2}</>;
    $[5] = t1;
    $[6] = t2;
    $[7] = t3;
  } else {
    t3 = $[7];
  }
  return t3;
}
export function Doctor(t0: Props) {
  const $ = _c(88);
  const {
    onDone
  } = t0;
  const agentDefinitions = useAppState(_temp);
  const mcpTools = useAppState(_temp2);
  const toolPermissionContext = useAppState(_temp3);
  const pluginsErrors = useAppState(_temp4);
  useExitOnCtrlCDWithKeybindings();
  const tools = useMemo<Tools>(
    () => assembleToolPool(toolPermissionContext, mcpTools || []),
    [toolPermissionContext, mcpTools],
  );
  const [diagnostic, setDiagnostic] = useState<DiagnosticInfo | null>(null);
  const [diagnosticLoadFailed, setDiagnosticLoadFailed] = useState(false);
  const [agentInfo, setAgentInfo] = useState<AgentInfo | null>(null);
  const [contextWarnings, setContextWarnings] = useState<ContextWarnings | null>(null);
  const [versionLockInfo, setVersionLockInfo] = useState<VersionLockInfo | null>(null);
  const validationErrors = useSettingsErrors();
  const distTagsPromise = useMemo(() => resolveDoctorDistTags({
    getDoctorDiagnostic,
    getNpmDistTags,
    getGcsDistTags
  }), []);
  const autoUpdatesChannel = getInitialSettings()?.autoUpdatesChannel ?? "latest";
  let t3;
  if ($[3] !== validationErrors) {
    t3 = validationErrors.filter(_temp7);
    $[3] = validationErrors;
    $[4] = t3;
  } else {
    t3 = $[4];
  }
  const errorsExcludingMcp = t3;
  let t4;
  if ($[5] === Symbol.for("react.memo_cache_sentinel")) {
    const envVars = [{
      name: "BASH_MAX_OUTPUT_LENGTH",
      default: BASH_MAX_OUTPUT_DEFAULT,
      upperLimit: BASH_MAX_OUTPUT_UPPER_LIMIT
    }, {
      name: "TASK_MAX_OUTPUT_LENGTH",
      default: TASK_MAX_OUTPUT_DEFAULT,
      upperLimit: TASK_MAX_OUTPUT_UPPER_LIMIT
    }, {
      name: "CLAUDE_CODE_MAX_OUTPUT_TOKENS",
      ...getModelMaxOutputTokens("claude-opus-4-6")
    }];
    t4 = envVars.map(_temp8).filter(_temp9);
    $[5] = t4;
  } else {
    t4 = $[5];
  }
  const envValidationErrors = t4;
  useEffect(() => {
    void loadDoctorDiagnostic(
      { getDoctorDiagnostic },
      { setDiagnostic, setDiagnosticLoadFailed },
    );
    (async () => {
      const userAgentsDir = join(getClaudeConfigHomeDir(), "agents");
      const projectAgentsDir = join(getOriginalCwd(), ".openclaude", "agents");
      const {
        activeAgents,
        allAgents,
        failedFiles
      } = agentDefinitions;
      const [userDirExists, projectDirExists] = await Promise.all([pathExists(userAgentsDir), pathExists(projectAgentsDir)]);
      const agentInfoData = {
        activeAgents: activeAgents.map(_temp0),
        userAgentsDir,
        projectAgentsDir,
        userDirExists,
        projectDirExists,
        failedFiles
      };
      setAgentInfo(agentInfoData);
      const warnings = await checkContextWarnings(tools, {
        activeAgents,
        allAgents,
        failedFiles
      }, async () => toolPermissionContext);
      setContextWarnings(warnings);
      if (isPidBasedLockingEnabled()) {
        const locksDir = join(getXDGStateHome(), "claude", "locks");
        const staleLocksCleaned = cleanupStaleLocks(locksDir);
        const locks = getAllLockInfo(locksDir);
        setVersionLockInfo({
          enabled: true,
          locks,
          locksDir,
          staleLocksCleaned
        });
      } else {
        setVersionLockInfo({
          enabled: false,
          locks: [],
          locksDir: "",
          staleLocksCleaned: 0
        });
      }
    })();
  }, [toolPermissionContext, tools, agentDefinitions]);
  let t7;
  if ($[11] !== onDone) {
    t7 = () => {
      onDone("OpenClaude diagnostics dismissed", {
        display: "system"
      });
    };
    $[11] = onDone;
    $[12] = t7;
  } else {
    t7 = $[12];
  }
  const handleDismiss = t7;
  let t8;
  if ($[13] !== handleDismiss) {
    t8 = {
      "confirm:yes": handleDismiss,
      "confirm:no": handleDismiss
    };
    $[13] = handleDismiss;
    $[14] = t8;
  } else {
    t8 = $[14];
  }
  let t9;
  if ($[15] === Symbol.for("react.memo_cache_sentinel")) {
    t9 = {
      context: "Confirmation"
    };
    $[15] = t9;
  } else {
    t9 = $[15];
  }
  useKeybindings(t8, t9);
  if (diagnosticLoadFailed && !diagnostic) {
    return <Pane><Text color="error">Failed to load installation status.</Text></Pane>;
  }
  if (!diagnostic) {
    let t10;
    if ($[16] === Symbol.for("react.memo_cache_sentinel")) {
      t10 = <Pane><Text dimColor={true}>Checking installation status…</Text></Pane>;
      $[16] = t10;
    } else {
      t10 = $[16];
    }
    return t10;
  }
  let t10;
  if ($[17] === Symbol.for("react.memo_cache_sentinel")) {
    t10 = <Text bold={true}>Diagnostics</Text>;
    $[17] = t10;
  } else {
    t10 = $[17];
  }
  let t11;
  if ($[18] !== diagnostic.installationType || $[19] !== diagnostic.version) {
    t11 = <Text>└ Currently running: {diagnostic.installationType} ({diagnostic.version})</Text>;
    $[18] = diagnostic.installationType;
    $[19] = diagnostic.version;
    $[20] = t11;
  } else {
    t11 = $[20];
  }
  let t12;
  if ($[21] !== diagnostic.packageManager) {
    t12 = diagnostic.packageManager && <Text>└ Package manager: {diagnostic.packageManager}</Text>;
    $[21] = diagnostic.packageManager;
    $[22] = t12;
  } else {
    t12 = $[22];
  }
  let t13;
  if ($[23] !== diagnostic.installationPath) {
    t13 = <Text>└ Path: {diagnostic.installationPath}</Text>;
    $[23] = diagnostic.installationPath;
    $[24] = t13;
  } else {
    t13 = $[24];
  }
  let t14;
  if ($[25] !== diagnostic.invokedBinary) {
    t14 = <Text>└ Invoked: {diagnostic.invokedBinary}</Text>;
    $[25] = diagnostic.invokedBinary;
    $[26] = t14;
  } else {
    t14 = $[26];
  }
  let t15;
  if ($[27] !== diagnostic.configInstallMethod) {
    t15 = <Text>└ Config install method: {diagnostic.configInstallMethod}</Text>;
    $[27] = diagnostic.configInstallMethod;
    $[28] = t15;
  } else {
    t15 = $[28];
  }
  const t16 = diagnostic.ripgrepStatus.working ? "OK" : "Not working";
  const t17 = diagnostic.ripgrepStatus.mode === "embedded" ? "bundled" : diagnostic.ripgrepStatus.mode === "builtin" ? "vendor" : diagnostic.ripgrepStatus.systemPath || "system";
  let t18;
  if ($[29] !== t16 || $[30] !== t17) {
    t18 = <Text>└ Search: {t16} ({t17})</Text>;
    $[29] = t16;
    $[30] = t17;
    $[31] = t18;
  } else {
    t18 = $[31];
  }
  let t19;
  if ($[32] !== diagnostic.recommendation) {
    t19 = diagnostic.recommendation && <><Text /><Text color="warning">Recommendation: {diagnostic.recommendation.split("\n")[0]}</Text><Text dimColor={true}>{diagnostic.recommendation.split("\n")[1]}</Text></>;
    $[32] = diagnostic.recommendation;
    $[33] = t19;
  } else {
    t19 = $[33];
  }
  let t20;
  if ($[34] !== diagnostic.multipleInstallations) {
    t20 = diagnostic.multipleInstallations.length > 1 && <><Text /><Text color="warning">Warning: Multiple installations found</Text>{diagnostic.multipleInstallations.map(_temp1)}</>;
    $[34] = diagnostic.multipleInstallations;
    $[35] = t20;
  } else {
    t20 = $[35];
  }
  let t21;
  if ($[36] !== diagnostic.warnings) {
    t21 = diagnostic.warnings.length > 0 && <><Text />{diagnostic.warnings.map(_temp10)}</>;
    $[36] = diagnostic.warnings;
    $[37] = t21;
  } else {
    t21 = $[37];
  }
  let t22;
  if ($[38] !== errorsExcludingMcp) {
    t22 = errorsExcludingMcp.length > 0 && <Box flexDirection="column" marginTop={1} marginBottom={1}><Text bold={true}>Invalid Settings</Text><ValidationErrorsList errors={errorsExcludingMcp} /></Box>;
    $[38] = errorsExcludingMcp;
    $[39] = t22;
  } else {
    t22 = $[39];
  }
  let t23;
  if ($[40] !== t11 || $[41] !== t12 || $[42] !== t13 || $[43] !== t14 || $[44] !== t15 || $[45] !== t18 || $[46] !== t19 || $[47] !== t20 || $[48] !== t21 || $[49] !== t22) {
    t23 = <Box flexDirection="column">{t10}{t11}{t12}{t13}{t14}{t15}{t18}{t19}{t20}{t21}{t22}</Box>;
    $[40] = t11;
    $[41] = t12;
    $[42] = t13;
    $[43] = t14;
    $[44] = t15;
    $[45] = t18;
    $[46] = t19;
    $[47] = t20;
    $[48] = t21;
    $[49] = t22;
    $[50] = t23;
  } else {
    t23 = $[50];
  }
  let t24;
  if ($[51] === Symbol.for("react.memo_cache_sentinel")) {
    t24 = <Text bold={true}>Updates</Text>;
    $[51] = t24;
  } else {
    t24 = $[51];
  }
  const t25 = diagnostic.packageManager ? "Managed by package manager" : diagnostic.autoUpdates;
  let t26;
  if ($[52] !== t25) {
    t26 = <Text>└ Auto-updates:{" "}{t25}</Text>;
    $[52] = t25;
    $[53] = t26;
  } else {
    t26 = $[53];
  }
  let t27;
  if ($[54] !== diagnostic.hasUpdatePermissions) {
    t27 = diagnostic.hasUpdatePermissions !== null && <Text>└ Update permissions:{" "}{diagnostic.hasUpdatePermissions ? "Yes" : "No (requires sudo)"}</Text>;
    $[54] = diagnostic.hasUpdatePermissions;
    $[55] = t27;
  } else {
    t27 = $[55];
  }
  let t28;
  if ($[56] !== autoUpdatesChannel) {
    t28 = <Text>└ Auto-update channel: {autoUpdatesChannel}</Text>;
    $[56] = autoUpdatesChannel;
    $[57] = t28;
  } else {
    t28 = $[57];
  }
  const t29 = <Suspense fallback={null}><DistTagsDisplay promise={distTagsPromise} /></Suspense>;
  const t30 = <Box flexDirection="column">{t24}{t26}{t27}{t28}{t29}</Box>;
  let t31;
  let t32;
  let t33;
  let t34;
  if ($[61] === Symbol.for("react.memo_cache_sentinel")) {
    t31 = <SandboxDoctorSection />;
    t32 = <McpParsingWarnings />;
    t33 = <KeybindingWarnings />;
    t34 = envValidationErrors.length > 0 && <Box flexDirection="column"><Text bold={true}>Environment Variables</Text>{envValidationErrors.map(_temp11)}</Box>;
    $[61] = t31;
    $[62] = t32;
    $[63] = t33;
    $[64] = t34;
  } else {
    t31 = $[61];
    t32 = $[62];
    t33 = $[63];
    t34 = $[64];
  }
  let t35;
  if ($[65] !== versionLockInfo) {
    t35 = versionLockInfo?.enabled && <Box flexDirection="column"><Text bold={true}>Version Locks</Text>{versionLockInfo.staleLocksCleaned > 0 && <Text dimColor={true}>└ Cleaned {versionLockInfo.staleLocksCleaned} stale lock(s)</Text>}{versionLockInfo.locks.length === 0 ? <Text dimColor={true}>└ No active version locks</Text> : versionLockInfo.locks.map(_temp12)}</Box>;
    $[65] = versionLockInfo;
    $[66] = t35;
  } else {
    t35 = $[66];
  }
  let t36;
  if ($[67] !== agentInfo) {
    t36 = agentInfo?.failedFiles && agentInfo.failedFiles.length > 0 && <Box flexDirection="column"><Text bold={true} color="error">Agent Parse Errors</Text><Text color="error">└ Failed to parse {agentInfo.failedFiles.length} agent file(s):</Text>{agentInfo.failedFiles.map(_temp13)}</Box>;
    $[67] = agentInfo;
    $[68] = t36;
  } else {
    t36 = $[68];
  }
  let t37;
  if ($[69] !== pluginsErrors) {
    t37 = pluginsErrors.length > 0 && <Box flexDirection="column"><Text bold={true} color="error">Plugin Errors</Text><Text color="error">└ {pluginsErrors.length} plugin error(s) detected:</Text>{pluginsErrors.map(_temp14)}</Box>;
    $[69] = pluginsErrors;
    $[70] = t37;
  } else {
    t37 = $[70];
  }
  let t38;
  if ($[71] !== contextWarnings) {
    t38 = contextWarnings?.unreachableRulesWarning && <Box flexDirection="column"><Text bold={true} color="warning">Unreachable Permission Rules</Text><Text>└{" "}<Text color="warning">{figures.warning}{" "}{contextWarnings.unreachableRulesWarning.message}</Text></Text>{contextWarnings.unreachableRulesWarning.details.map(_temp15)}</Box>;
    $[71] = contextWarnings;
    $[72] = t38;
  } else {
    t38 = $[72];
  }
  const isLocalModel = isActiveProviderLocalModel();
  const localModelContextLoad = isLocalModel ? buildLocalModelContextLoad(contextWarnings) : null;
  let t39;
  if ($[73] !== contextWarnings || $[74] !== localModelContextLoad) {
    t39 = !localModelContextLoad && contextWarnings && (contextWarnings.claudeMdWarning || contextWarnings.agentWarning || contextWarnings.mcpWarning) && <Box flexDirection="column"><Text bold={true}>Context Usage Warnings</Text>{contextWarnings.claudeMdWarning && <><Text>└{" "}<Text color="warning">{figures.warning} {contextWarnings.claudeMdWarning.message}</Text></Text><Text>{"  "}└ Files:</Text>{contextWarnings.claudeMdWarning.details.map(_temp16)}</>}{contextWarnings.agentWarning && <><Text>└{" "}<Text color="warning">{figures.warning} {contextWarnings.agentWarning.message}</Text></Text><Text>{"  "}└ Top contributors:</Text>{contextWarnings.agentWarning.details.map(_temp17)}</>}{contextWarnings.mcpWarning && <><Text>└{" "}<Text color="warning">{figures.warning} {contextWarnings.mcpWarning.message}</Text></Text><Text>{"  "}└ MCP servers:</Text>{contextWarnings.mcpWarning.details.map(_temp18)}</>}</Box>;
    $[73] = contextWarnings;
    $[74] = localModelContextLoad;
    $[75] = t39;
  } else {
    t39 = $[75];
  }
  let t39b;
  if ($[76] !== localModelContextLoad) {
    t39b = localModelContextLoad && <Box flexDirection="column"><Text bold={true}>Local Model Context Load</Text><Text>└ Large context loaded before turn one for this local provider:</Text>{localModelContextLoad.contributors.map(_temp19)}<Text dimColor={true}>└ Disable unused MCP servers, agents, or oversized memory files to free context.</Text></Box>;
    $[76] = localModelContextLoad;
    $[77] = t39b;
  } else {
    t39b = $[77];
  }
  let t40;
  if ($[78] === Symbol.for("react.memo_cache_sentinel")) {
    t40 = <Box><PressEnterToContinue /></Box>;
    $[78] = t40;
  } else {
    t40 = $[78];
  }
  let t41;
  if ($[79] !== t23 || $[80] !== t30 || $[81] !== t35 || $[82] !== t36 || $[83] !== t37 || $[84] !== t38 || $[85] !== t39 || $[86] !== t39b) {
    t41 = <Pane>{t23}{t30}{t31}{t32}{t33}{t34}{t35}{t36}{t37}{t38}{t39}{t39b}{t40}</Pane>;
    $[79] = t23;
    $[80] = t30;
    $[81] = t35;
    $[82] = t36;
    $[83] = t37;
    $[84] = t38;
    $[85] = t39;
    $[86] = t39b;
    $[87] = t41;
  } else {
    t41 = $[87];
  }
  return t41;
}
function _temp19(contributor) {
  return <React.Fragment key={contributor.id}><Text>└{" "}<Text color="warning">{figures.warning} {contributor.message}</Text></Text>{contributor.details.map(_temp20)}</React.Fragment>;
}
function _temp20(detail, i) {
  return <Text key={i} dimColor={true}>{"  "}└ {detail}</Text>;
}
function _temp18(detail_2, i_8) {
  return <Text key={i_8} dimColor={true}>{"    "}└ {detail_2}</Text>;
}
function _temp17(detail_1, i_7) {
  return <Text key={i_7} dimColor={true}>{"    "}└ {detail_1}</Text>;
}
function _temp16(detail_0, i_6) {
  return <Text key={i_6} dimColor={true}>{"    "}└ {detail_0}</Text>;
}
function _temp15(detail, i_5) {
  return <Text key={i_5} dimColor={true}>{"  "}└ {detail}</Text>;
}
function _temp14(error_0, i_4) {
  return <Text key={i_4} dimColor={true}>{"  "}└ {error_0.source || "unknown"}{"plugin" in error_0 && error_0.plugin ? ` [${error_0.plugin}]` : ""}:{" "}{getPluginErrorMessage(error_0)}</Text>;
}
function _temp13(file, i_3) {
  return <Text key={i_3} dimColor={true}>{"  "}└ {file.path}: {file.error}</Text>;
}
function _temp12(lock, i_2) {
  return <Text key={i_2}>└ {lock.version}: PID {lock.pid}{" "}{lock.isProcessRunning ? <Text>(running)</Text> : <Text color="warning">(stale)</Text>}</Text>;
}
function _temp11(validation, i_1) {
  return <Text key={i_1}>└ {validation.name}:{" "}<Text color={validation.status === "capped" ? "warning" : "error"}>{validation.message}</Text></Text>;
}
function _temp10(warning, i_0) {
  return <Box key={i_0} flexDirection="column"><Text color="warning">Warning: {warning.issue}</Text><Text>Fix: {warning.fix}</Text></Box>;
}
function _temp1(install, i) {
  return <Text key={i}>└ {install.type} at {install.path}</Text>;
}
function _temp0(a) {
  return {
    agentType: a.agentType,
    source: a.source
  };
}
function _temp9(v_0) {
  return v_0.status !== "valid";
}
function _temp8(v) {
  const value = process.env[v.name];
  const result = validateBoundedIntEnvVar(v.name, value, v.default, v.upperLimit);
  return {
    name: v.name,
    ...result
  };
}
function _temp7(error) {
  return error.mcpErrorMetadata === undefined;
}
function _temp4(s_2) {
  return s_2.plugins.errors;
}
function _temp3(s_1) {
  return s_1.toolPermissionContext;
}
function _temp2(s_0) {
  return s_0.mcp.tools;
}
function _temp(s) {
  return s.agentDefinitions;
}
