import { c as _c } from "react-compiler-runtime";
import React, { useState } from 'react';
import TextInput from '../../components/TextInput.js';
import { useTerminalSize } from '../../hooks/useTerminalSize.js';
import { Box, color, Text, useTheme } from '../../ink.js';
import { useKeybindings } from '../../keybindings/useKeybinding.js';
interface ApiKeyStepProps {
  existingApiKey: string | null;
  useExistingKey: boolean;
  apiKeyOrOAuthToken: string;
  onApiKeyChange: (value: string) => void;
  onToggleUseExistingKey: (useExisting: boolean) => void;
  onSubmit: () => void;
  onCreateOAuthToken?: () => void;
  selectedOption?: 'existing' | 'new' | 'oauth';
  onSelectOption?: (option: 'existing' | 'new' | 'oauth') => void;
}
export function ApiKeyStep(t0) {
  const $ = _c(55);
  const {
    existingApiKey,
    apiKeyOrOAuthToken,
    onApiKeyChange,
    onSubmit,
    onToggleUseExistingKey,
    onCreateOAuthToken,
    selectedOption: t1,
    onSelectOption
  } = t0;
  const selectedOption = t1 === undefined ? existingApiKey ? "existing" : onCreateOAuthToken ? "oauth" : "new" : t1;
  const [cursorOffset, setCursorOffset] = useState(0);
  const terminalSize = useTerminalSize();
  const [theme] = useTheme();
  let t2;
  if ($[0] !== existingApiKey || $[1] !== onCreateOAuthToken || $[2] !== onSelectOption || $[3] !== onToggleUseExistingKey || $[4] !== selectedOption) {
    t2 = () => {
      if (selectedOption === "new" && onCreateOAuthToken) {
        onSelectOption?.("oauth");
      } else {
        if (selectedOption === "oauth" && existingApiKey) {
          onSelectOption?.("existing");
          onToggleUseExistingKey(true);
        }
      }
    };
    $[0] = existingApiKey;
    $[1] = onCreateOAuthToken;
    $[2] = onSelectOption;
    $[3] = onToggleUseExistingKey;
    $[4] = selectedOption;
    $[5] = t2;
  } else {
    t2 = $[5];
  }
  const handlePrevious = t2;
  let t3;
  if ($[6] !== onCreateOAuthToken || $[7] !== onSelectOption || $[8] !== onToggleUseExistingKey || $[9] !== selectedOption) {
    t3 = () => {
      if (selectedOption === "existing") {
        onSelectOption?.(onCreateOAuthToken ? "oauth" : "new");
        onToggleUseExistingKey(false);
      } else {
        if (selectedOption === "oauth") {
          onSelectOption?.("new");
        }
      }
    };
    $[6] = onCreateOAuthToken;
    $[7] = onSelectOption;
    $[8] = onToggleUseExistingKey;
    $[9] = selectedOption;
    $[10] = t3;
  } else {
    t3 = $[10];
  }
  const handleNext = t3;
  let t4;
  if ($[11] !== onCreateOAuthToken || $[12] !== onSubmit || $[13] !== selectedOption) {
    t4 = () => {
      if (selectedOption === "oauth" && onCreateOAuthToken) {
        onCreateOAuthToken();
      } else {
        onSubmit();
      }
    };
    $[11] = onCreateOAuthToken;
    $[12] = onSubmit;
    $[13] = selectedOption;
    $[14] = t4;
  } else {
    t4 = $[14];
  }
  const handleConfirm = t4;
  const isTextInputVisible = selectedOption === "new";
  let t5;
  if ($[15] !== handleConfirm || $[16] !== handleNext || $[17] !== handlePrevious) {
    t5 = {
      "confirm:previous": handlePrevious,
      "confirm:next": handleNext,
      "confirm:yes": handleConfirm
    };
    $[15] = handleConfirm;
    $[16] = handleNext;
    $[17] = handlePrevious;
    $[18] = t5;
  } else {
    t5 = $[18];
  }
  const t6 = !isTextInputVisible;
  let t7;
  if ($[19] !== t6) {
    t7 = {
      context: "Confirmation",
      isActive: t6
    };
    $[19] = t6;
    $[20] = t7;
  } else {
    t7 = $[20];
  }
  useKeybindings(t5, t7);
  let t8;
  if ($[21] !== handleNext || $[22] !== handlePrevious) {
    t8 = {
      "confirm:previous": handlePrevious,
      "confirm:next": handleNext
    };
    $[21] = handleNext;
    $[22] = handlePrevious;
    $[23] = t8;
  } else {
    t8 = $[23];
  }
  let t9;
  if ($[24] !== isTextInputVisible) {
    t9 = {
      context: "Confirmation",
      isActive: isTextInputVisible
    };
    $[24] = isTextInputVisible;
    $[25] = t9;
  } else {
    t9 = $[25];
  }
  useKeybindings(t8, t9);
  let t10;
  if ($[26] === Symbol.for("react.memo_cache_sentinel")) {
    t10 = <Box flexDirection="column" marginBottom={1}><Text bold={true}>Install GitHub App</Text><Text dimColor={true}>Choose API key</Text></Box>;
    $[26] = t10;
  } else {
    t10 = $[26];
  }
  let t11;
  if ($[27] !== existingApiKey || $[28] !== selectedOption || $[29] !== theme) {
    t11 = existingApiKey && <Box marginBottom={1}><Text>{selectedOption === "existing" ? color("success", theme)("> ") : "  "}Use your existing Claude Code API key</Text></Box>;
    $[27] = existingApiKey;
    $[28] = selectedOption;
    $[29] = theme;
    $[30] = t11;
  } else {
    t11 = $[30];
  }
  let t12;
  if ($[31] !== onCreateOAuthToken || $[32] !== selectedOption || $[33] !== theme) {
    t12 = onCreateOAuthToken && <Box marginBottom={1}><Text>{selectedOption === "oauth" ? color("success", theme)("> ") : "  "}Create a long-lived token with your Claude subscription</Text></Box>;
    $[31] = onCreateOAuthToken;
    $[32] = selectedOption;
    $[33] = theme;
    $[34] = t12;
  } else {
    t12 = $[34];
  }
  let t13;
  if ($[35] !== selectedOption || $[36] !== theme) {
    t13 = selectedOption === "new" ? color("success", theme)("> ") : "  ";
    $[35] = selectedOption;
    $[36] = theme;
    $[37] = t13;
  } else {
    t13 = $[37];
  }
  let t14;
  if ($[38] !== t13) {
    t14 = <Box marginBottom={1}><Text>{t13}Enter a new API key</Text></Box>;
    $[38] = t13;
    $[39] = t14;
  } else {
    t14 = $[39];
  }
  let t15;
  if ($[40] !== apiKeyOrOAuthToken || $[41] !== cursorOffset || $[42] !== onApiKeyChange || $[43] !== onSubmit || $[44] !== selectedOption || $[45] !== terminalSize) {
    t15 = selectedOption === "new" && <TextInput value={apiKeyOrOAuthToken} onChange={onApiKeyChange} onSubmit={onSubmit} onPaste={onApiKeyChange} focus={true} placeholder={"sk-ant\u2026 (Create a new key at https://platform.claude.com/settings/keys)"} mask="*" columns={terminalSize.columns} cursorOffset={cursorOffset} onChangeCursorOffset={setCursorOffset} showCursor={true} />;
    $[40] = apiKeyOrOAuthToken;
    $[41] = cursorOffset;
    $[42] = onApiKeyChange;
    $[43] = onSubmit;
    $[44] = selectedOption;
    $[45] = terminalSize;
    $[46] = t15;
  } else {
    t15 = $[46];
  }
  let t16;
  if ($[47] !== t11 || $[48] !== t12 || $[49] !== t14 || $[50] !== t15) {
    t16 = <Box flexDirection="column" borderStyle="round" paddingX={1}>{t10}{t11}{t12}{t14}{t15}</Box>;
    $[47] = t11;
    $[48] = t12;
    $[49] = t14;
    $[50] = t15;
    $[51] = t16;
  } else {
    t16 = $[51];
  }
  let t17;
  if ($[52] === Symbol.for("react.memo_cache_sentinel")) {
    t17 = <Box marginLeft={3}><Text dimColor={true}>↑/↓ to select · Enter to continue</Text></Box>;
    $[52] = t17;
  } else {
    t17 = $[52];
  }
  let t18;
  if ($[53] !== t16) {
    t18 = <>{t16}{t17}</>;
    $[53] = t16;
    $[54] = t18;
  } else {
    t18 = $[54];
  }
  return t18;
}
