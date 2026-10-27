import { c as _c } from "react-compiler-runtime";
import React, { type ReactNode, useState } from 'react';
import { PRODUCT_DISPLAY_NAME } from '../../../../constants/product.js';
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
export function DescriptionStep() {
  const $ = _c(18);
  const {
    goNext,
    goBack,
    updateWizardData,
    wizardData
  } = useWizard<AgentWizardData>();
  const [whenToUse, setWhenToUse] = useState(wizardData.whenToUse || "");
  const [cursorOffset, setCursorOffset] = useState(whenToUse.length);
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
  if ($[1] !== whenToUse) {
    t1 = async () => {
      const result = await editPromptInEditor(whenToUse);
      if (result.content !== null) {
        setWhenToUse(result.content);
        setCursorOffset(result.content.length);
      }
    };
    $[1] = whenToUse;
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
  if ($[4] !== goNext || $[5] !== updateWizardData) {
    t3 = value => {
      const trimmedValue = value.trim();
      if (!trimmedValue) {
        setError("Description is required");
        return;
      }
      setError(null);
      updateWizardData({
        whenToUse: trimmedValue
      });
      goNext();
    };
    $[4] = goNext;
    $[5] = updateWizardData;
    $[6] = t3;
  } else {
    t3 = $[6];
  }
  const handleSubmit = t3;
  let t4;
  if ($[7] === Symbol.for("react.memo_cache_sentinel")) {
    t4 = <Byline><KeyboardShortcutHint shortcut="Type" action="enter text" /><KeyboardShortcutHint shortcut="Enter" action="continue" /><ConfigurableShortcutHint action="chat:externalEditor" context="Chat" fallback="ctrl+g" description="open in editor" /><ConfigurableShortcutHint action="confirm:no" context="Settings" fallback="Esc" description="go back" /></Byline>;
    $[7] = t4;
  } else {
    t4 = $[7];
  }
  let t5;
  if ($[8] === Symbol.for("react.memo_cache_sentinel")) {
    t5 = <Text>When should {PRODUCT_DISPLAY_NAME} use this agent?</Text>;
    $[8] = t5;
  } else {
    t5 = $[8];
  }
  let t6;
  if ($[9] !== cursorOffset || $[10] !== handleSubmit || $[11] !== whenToUse) {
    t6 = <Box marginTop={1}><TextInput value={whenToUse} onChange={setWhenToUse} onSubmit={handleSubmit} placeholder="e.g., use this agent after you're done writing code..." columns={80} cursorOffset={cursorOffset} onChangeCursorOffset={setCursorOffset} focus={true} showCursor={true} /></Box>;
    $[9] = cursorOffset;
    $[10] = handleSubmit;
    $[11] = whenToUse;
    $[12] = t6;
  } else {
    t6 = $[12];
  }
  let t7;
  if ($[13] !== error) {
    t7 = error && <Box marginTop={1}><Text color="error">{error}</Text></Box>;
    $[13] = error;
    $[14] = t7;
  } else {
    t7 = $[14];
  }
  let t8;
  if ($[15] !== t6 || $[16] !== t7) {
    t8 = <WizardDialogLayout subtitle={`Description (tell ${PRODUCT_DISPLAY_NAME} when to use this agent)`} footerText={t4}><Box flexDirection="column">{t5}{t6}{t7}</Box></WizardDialogLayout>;
    $[15] = t6;
    $[16] = t7;
    $[17] = t8;
  } else {
    t8 = $[17];
  }
  return t8;
}
