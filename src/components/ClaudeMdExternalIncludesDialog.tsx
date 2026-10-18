import { c as _c } from "react-compiler-runtime";
import { join } from 'path';
import React from 'react';
import { logEvent } from 'src/services/analytics/index.js';
import { Box, Link, Text } from '../ink.js';
import type { ExternalClaudeMdInclude } from '../utils/claudemd.js';
import { saveCurrentProjectConfig } from '../utils/config.js';
import type { ProjectConfig } from '../utils/config.js';
import { getClaudeConfigHomeDir } from '../utils/envUtils.js';
import { getDisplayPath } from '../utils/file.js';
import { Select } from './CustomSelect/index.js';
import { Dialog } from './design-system/Dialog.js';
type Props = {
  onDone(): void;
  isStandaloneDialog?: boolean;
  externalIncludes?: ExternalClaudeMdInclude[];
  scope?: 'User' | 'Project';
};
function acceptProject(current: ProjectConfig) {
  return { ...current, hasClaudeMdExternalIncludesApproved: true, hasClaudeMdExternalIncludesWarningShown: true };
}
function acceptUser(current: ProjectConfig) {
  return { ...current, hasClaudeMdExternalIncludesApprovedForUser: true, hasClaudeMdExternalIncludesWarningShownForUser: true };
}
function declineProject(current: ProjectConfig) {
  return { ...current, hasClaudeMdExternalIncludesApproved: false, hasClaudeMdExternalIncludesWarningShown: true };
}
function declineUser(current: ProjectConfig) {
  return { ...current, hasClaudeMdExternalIncludesApprovedForUser: false, hasClaudeMdExternalIncludesWarningShownForUser: true };
}
function getUserClaudeMdDisplayPath(): string {
  return getDisplayPath(join(getClaudeConfigHomeDir(), 'CLAUDE.md'));
}
export function ClaudeMdExternalIncludesDialog(t0: Props) {
  const $ = _c(18);
  const { onDone, isStandaloneDialog, externalIncludes, scope } = t0;
  React.useEffect(_temp, []);
  const handleSelection = React.useCallback((value: 'yes' | 'no') => {
    if (value === "no") {
      logEvent("tengu_claude_md_external_includes_dialog_declined", {});
      saveCurrentProjectConfig(scope === 'User' ? declineUser : declineProject);
    } else {
      logEvent("tengu_claude_md_external_includes_dialog_accepted", {});
      saveCurrentProjectConfig(scope === 'User' ? acceptUser : acceptProject);
    }
    onDone();
  }, [onDone, scope]);
  const handleEscape = React.useCallback(() => handleSelection("no"), [handleSelection]);
  const title = scope === 'User'
    ? "Allow user CLAUDE.md file imports?"
    : "Allow external CLAUDE.md file imports?";
  const description = scope === 'User'
    ? <Text>Your user CLAUDE.md ({getUserClaudeMdDisplayPath()}) imports files outside the current working directory.</Text>
    : <Text>This project's CLAUDE.md imports files outside the current working directory. Never allow this for third-party repositories.</Text>;
  return (
    <Dialog title={title} color="warning" onCancel={handleEscape} hideBorder={!isStandaloneDialog} hideInputGuide={!isStandaloneDialog}>
      {description}
      {externalIncludes && externalIncludes.length > 0 && (
        <Box flexDirection="column">
          <Text dimColor={true}>External imports:</Text>
          {externalIncludes.map((include, i) => (
            <Text key={i} dimColor={true}>{"  "}{include.path}</Text>
          ))}
        </Box>
      )}
      <Text dimColor={true}>Important: Only use Claude Code with files you trust. Accessing untrusted files may pose security risks{" "}<Link url="https://code.claude.com/docs/en/security" />{" "}</Text>
      <Select options={[
        { label: "Yes, allow external imports", value: "yes" },
        { label: "No, disable external imports", value: "no" },
      ]} onChange={(value: string) => handleSelection(value as 'yes' | 'no')} />
    </Dialog>
  );
}
function _temp() {
  logEvent("tengu_claude_md_includes_dialog_shown", {});
}
