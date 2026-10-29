import { c as _c } from "react-compiler-runtime";
import React, { useState } from 'react';
import TextInput from '../../components/TextInput.js';
import { useTerminalSize } from '../../hooks/useTerminalSize.js';
import { Box, Text } from '../../ink.js';
import { useKeybindings } from '../../keybindings/useKeybinding.js';
interface ChooseRepoStepProps {
  currentRepo: string | null;
  useCurrentRepo: boolean;
  repoUrl: string;
  onRepoUrlChange: (value: string) => void;
  onToggleUseCurrentRepo: (useCurrentRepo: boolean) => void;
  onSubmit: () => void;
}
export function ChooseRepoStep(t0) {
  const $ = _c(49);
  const {
    currentRepo,
    useCurrentRepo,
    repoUrl,
    onRepoUrlChange,
    onSubmit,
    onToggleUseCurrentRepo
  } = t0;
  const [cursorOffset, setCursorOffset] = useState(0);
  const [showEmptyError, setShowEmptyError] = useState(false);
  const terminalSize = useTerminalSize();
  const textInputColumns = terminalSize.columns;
  let t1;
  if ($[0] !== currentRepo || $[1] !== onSubmit || $[2] !== repoUrl || $[3] !== useCurrentRepo) {
    t1 = () => {
      const repoName = useCurrentRepo ? currentRepo : repoUrl;
      if (!repoName?.trim()) {
        setShowEmptyError(true);
        return;
      }
      onSubmit();
    };
    $[0] = currentRepo;
    $[1] = onSubmit;
    $[2] = repoUrl;
    $[3] = useCurrentRepo;
    $[4] = t1;
  } else {
    t1 = $[4];
  }
  const handleSubmit = t1;
  const isTextInputVisible = !useCurrentRepo || !currentRepo;
  let t2;
  if ($[5] !== onToggleUseCurrentRepo) {
    t2 = () => {
      onToggleUseCurrentRepo(true);
      setShowEmptyError(false);
    };
    $[5] = onToggleUseCurrentRepo;
    $[6] = t2;
  } else {
    t2 = $[6];
  }
  const handlePrevious = t2;
  let t3;
  if ($[7] !== onToggleUseCurrentRepo) {
    t3 = () => {
      onToggleUseCurrentRepo(false);
      setShowEmptyError(false);
    };
    $[7] = onToggleUseCurrentRepo;
    $[8] = t3;
  } else {
    t3 = $[8];
  }
  const handleNext = t3;
  let t4;
  if ($[9] !== handleNext || $[10] !== handlePrevious || $[11] !== handleSubmit) {
    t4 = {
      "confirm:previous": handlePrevious,
      "confirm:next": handleNext,
      "confirm:yes": handleSubmit
    };
    $[9] = handleNext;
    $[10] = handlePrevious;
    $[11] = handleSubmit;
    $[12] = t4;
  } else {
    t4 = $[12];
  }
  const t5 = !isTextInputVisible;
  let t6;
  if ($[13] !== t5) {
    t6 = {
      context: "Confirmation",
      isActive: t5
    };
    $[13] = t5;
    $[14] = t6;
  } else {
    t6 = $[14];
  }
  useKeybindings(t4, t6);
  let t7;
  if ($[15] !== handleNext || $[16] !== handlePrevious) {
    t7 = {
      "confirm:previous": handlePrevious,
      "confirm:next": handleNext
    };
    $[15] = handleNext;
    $[16] = handlePrevious;
    $[17] = t7;
  } else {
    t7 = $[17];
  }
  let t8;
  if ($[18] !== isTextInputVisible) {
    t8 = {
      context: "Confirmation",
      isActive: isTextInputVisible
    };
    $[18] = isTextInputVisible;
    $[19] = t8;
  } else {
    t8 = $[19];
  }
  useKeybindings(t7, t8);
  let t9;
  if ($[20] === Symbol.for("react.memo_cache_sentinel")) {
    t9 = <Box flexDirection="column" marginBottom={1}><Text bold={true}>Install GitHub App</Text><Text dimColor={true}>Select GitHub repository</Text></Box>;
    $[20] = t9;
  } else {
    t9 = $[20];
  }
  let t10;
  if ($[21] !== currentRepo || $[22] !== useCurrentRepo) {
    t10 = currentRepo && <Box marginBottom={1}><Text bold={useCurrentRepo} color={useCurrentRepo ? "permission" : undefined}>{useCurrentRepo ? "> " : "  "}Use current repository: {currentRepo}</Text></Box>;
    $[21] = currentRepo;
    $[22] = useCurrentRepo;
    $[23] = t10;
  } else {
    t10 = $[23];
  }
  const t11 = !useCurrentRepo || !currentRepo;
  const t12 = !useCurrentRepo || !currentRepo ? "permission" : undefined;
  const t13 = !useCurrentRepo || !currentRepo ? "> " : "  ";
  const t14 = currentRepo ? "Enter a different repository" : "Enter repository";
  let t15;
  if ($[24] !== t11 || $[25] !== t12 || $[26] !== t13 || $[27] !== t14) {
    t15 = <Box marginBottom={1}><Text bold={t11} color={t12}>{t13}{t14}</Text></Box>;
    $[24] = t11;
    $[25] = t12;
    $[26] = t13;
    $[27] = t14;
    $[28] = t15;
  } else {
    t15 = $[28];
  }
  let t16;
  if ($[29] !== currentRepo || $[30] !== cursorOffset || $[31] !== handleSubmit || $[32] !== onRepoUrlChange || $[33] !== repoUrl || $[34] !== textInputColumns || $[35] !== useCurrentRepo) {
    t16 = (!useCurrentRepo || !currentRepo) && <Box marginLeft={2} marginBottom={1}><TextInput value={repoUrl} onChange={value => {
        onRepoUrlChange(value);
        setShowEmptyError(false);
      }} onSubmit={handleSubmit} focus={true} placeholder={"Enter a repo as owner/repo or https://github.com/owner/repo\u2026"} columns={textInputColumns} cursorOffset={cursorOffset} onChangeCursorOffset={setCursorOffset} showCursor={true} /></Box>;
    $[29] = currentRepo;
    $[30] = cursorOffset;
    $[31] = handleSubmit;
    $[32] = onRepoUrlChange;
    $[33] = repoUrl;
    $[34] = textInputColumns;
    $[35] = useCurrentRepo;
    $[36] = t16;
  } else {
    t16 = $[36];
  }
  let t17;
  if ($[37] !== t10 || $[38] !== t15 || $[39] !== t16) {
    t17 = <Box flexDirection="column" borderStyle="round" paddingX={1}>{t9}{t10}{t15}{t16}</Box>;
    $[37] = t10;
    $[38] = t15;
    $[39] = t16;
    $[40] = t17;
  } else {
    t17 = $[40];
  }
  let t18;
  if ($[41] !== showEmptyError) {
    t18 = showEmptyError && <Box marginLeft={3} marginBottom={1}><Text color="error">Please enter a repository name to continue</Text></Box>;
    $[41] = showEmptyError;
    $[42] = t18;
  } else {
    t18 = $[42];
  }
  const t19 = currentRepo ? "\u2191/\u2193 to select \xB7 " : "";
  let t20;
  if ($[43] !== t19) {
    t20 = <Box marginLeft={3}><Text dimColor={true}>{t19}Enter to continue</Text></Box>;
    $[43] = t19;
    $[44] = t20;
  } else {
    t20 = $[44];
  }
  let t21;
  if ($[45] !== t17 || $[46] !== t18 || $[47] !== t20) {
    t21 = <>{t17}{t18}{t20}</>;
    $[45] = t17;
    $[46] = t18;
    $[47] = t20;
    $[48] = t21;
  } else {
    t21 = $[48];
  }
  return t21;
}
