import { c as _c } from "react-compiler-runtime";
import React, { type ReactNode, useState } from 'react';
import { Box, Text } from '../../../../ink.js';
import { useKeybinding } from '../../../../keybindings/useKeybinding.js';
import { editPromptInEditor } from '../../../../utils/promptEditor.js';
import { ConfigurableShortcutHint } from '../../../ConfigurableShortcutHint.js';
import { Byline } from '../../../design-system/Byline.js';
import { KeyboardShortcutHint } from '../../../design-system/KeyboardShortcutHint.js';
import TextInput from '../../../TextInput.js';
import { useWizard } from '../../../wizard/index.js';
import { WizardDialogLayout } from '../../../wizard/WizardDialogLayout.js';
import type { AgentWizardData } from '../types.js';
export function PromptStep() {
  const $ = _c(20);
  const {
    goNext,
    goBack,
    updateWizardData,
    wizardData
  } = useWizard<AgentWizardData>();
  const [systemPrompt, setSystemPrompt] = useState(wizardData.systemPrompt || "");
  const [cursorOffset, setCursorOffset] = useState(systemPrompt.length);
  const [error, setError] = useState<string | null>(null);
  let t0;
  if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
    t0 = {
      context: "Settings"
    };
    $[0] = t0;
  } else {
    t0 = $[0];
  }
  useKeybinding("confirm:no", goBack, t0);
  let t1;
  if ($[1] !== systemPrompt) {
    t1 = async () => {
      const result = await editPromptInEditor(systemPrompt);
      if (result.content !== null) {
        setSystemPrompt(result.content);
        setCursorOffset(result.content.length);
      }
    };
    $[1] = systemPrompt;
    $[2] = t1;
  } else {
    t1 = $[2];
  }
  const handleExternalEditor = t1;
  let t2;
  if ($[3] === Symbol.for("react.memo_cache_sentinel")) {
    t2 = {
      context: "Chat"
    };
    $[3] = t2;
  } else {
    t2 = $[3];
  }
  useKeybinding("chat:externalEditor", handleExternalEditor, t2);
  let t3;
  if ($[4] !== goNext || $[5] !== systemPrompt || $[6] !== updateWizardData) {
    t3 = () => {
      const trimmedPrompt = systemPrompt.trim();
      if (!trimmedPrompt) {
        setError("System prompt is required");
        return;
      }
      setError(null);
      updateWizardData({
        systemPrompt: trimmedPrompt
      });
      goNext();
    };
    $[4] = goNext;
    $[5] = systemPrompt;
    $[6] = updateWizardData;
    $[7] = t3;
  } else {
    t3 = $[7];
  }
  const handleSubmit = t3;
  let t4;
  if ($[8] === Symbol.for("react.memo_cache_sentinel")) {
    t4 = <Byline><KeyboardShortcutHint shortcut="Type" action="enter text" /><KeyboardShortcutHint shortcut="Enter" action="continue" /><ConfigurableShortcutHint action="chat:externalEditor" context="Chat" fallback="ctrl+g" description="open in editor" /><ConfigurableShortcutHint action="confirm:no" context="Settings" fallback="Esc" description="go back" /></Byline>;
    $[8] = t4;
  } else {
    t4 = $[8];
  }
  let t5;
  let t6;
  if ($[9] === Symbol.for("react.memo_cache_sentinel")) {
    t5 = <Text>Enter the system prompt for your agent:</Text>;
    t6 = <Text dimColor={true}>Be comprehensive for best results</Text>;
    $[9] = t5;
    $[10] = t6;
  } else {
    t5 = $[9];
    t6 = $[10];
  }
  let t7;
  if ($[11] !== cursorOffset || $[12] !== handleSubmit || $[13] !== systemPrompt) {
    t7 = <Box marginTop={1}><TextInput value={systemPrompt} onChange={setSystemPrompt} onSubmit={handleSubmit} placeholder="You are a helpful code reviewer who..." columns={80} cursorOffset={cursorOffset} onChangeCursorOffset={setCursorOffset} focus={true} showCursor={true} /></Box>;
    $[11] = cursorOffset;
    $[12] = handleSubmit;
    $[13] = systemPrompt;
    $[14] = t7;
  } else {
    t7 = $[14];
  }
  let t8;
  if ($[15] !== error) {
    t8 = error && <Box marginTop={1}><Text color="error">{error}</Text></Box>;
    $[15] = error;
    $[16] = t8;
  } else {
    t8 = $[16];
  }
  let t9;
  if ($[17] !== t7 || $[18] !== t8) {
    t9 = <WizardDialogLayout subtitle="System prompt" footerText={t4}><Box flexDirection="column">{t5}{t6}{t7}{t8}</Box></WizardDialogLayout>;
    $[17] = t7;
    $[18] = t8;
    $[19] = t9;
  } else {
    t9 = $[19];
  }
  return t9;
}
