import { c as _c } from "react-compiler-runtime";
import React, { useEffect, useState } from 'react';
import { checkIsGitClean, checkNeedsClaudeAiLogin } from 'src/utils/background/remote/preconditions.js';
import { gracefulShutdownSync } from 'src/utils/gracefulShutdown.js';
import { Box, Text } from '../ink.js';
import { ConsoleOAuthFlow } from './ConsoleOAuthFlow.js';
import { Select } from './CustomSelect/index.js';
import { Dialog } from './design-system/Dialog.js';
import { TeleportStash } from './TeleportStash.js';
export type TeleportLocalErrorType = 'needsLogin' | 'needsGitStash';
type TeleportErrorProps = {
  onComplete: () => void;
  errorsToIgnore?: ReadonlySet<TeleportLocalErrorType>;
};

// Module-level sentinel so the default parameter has stable identity.
// Previously `= new Set()` created a fresh Set every render, which put
// a new object in checkErrors' deps and caused the mount effect to
// re-fire on every render.
const EMPTY_ERRORS_TO_IGNORE: ReadonlySet<TeleportLocalErrorType> = new Set();
export function TeleportError(t0) {
  const $ = _c(18);
  const {
    onComplete,
    errorsToIgnore: t1
  } = t0;
  const errorsToIgnore = t1 === undefined ? EMPTY_ERRORS_TO_IGNORE : t1;
  const [currentError, setCurrentError] = useState<TeleportLocalErrorType | null>(null);
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  let t2;
  if ($[0] !== errorsToIgnore || $[1] !== onComplete) {
    t2 = async () => {
      const currentErrors = await getTeleportErrors();
      const filteredErrors = new Set(Array.from(currentErrors).filter(error => !errorsToIgnore.has(error)));
      if (filteredErrors.size === 0) {
        onComplete();
        return;
      }
      if (filteredErrors.has("needsLogin")) {
        setCurrentError("needsLogin");
      } else {
        if (filteredErrors.has("needsGitStash")) {
          setCurrentError("needsGitStash");
        }
      }
    };
    $[0] = errorsToIgnore;
    $[1] = onComplete;
    $[2] = t2;
  } else {
    t2 = $[2];
  }
  const checkErrors = t2;
  let t3;
  let t4;
  if ($[3] !== checkErrors) {
    t3 = () => {
      checkErrors();
    };
    t4 = [checkErrors];
    $[3] = checkErrors;
    $[4] = t3;
    $[5] = t4;
  } else {
    t3 = $[4];
    t4 = $[5];
  }
  useEffect(t3, t4);
  const onCancel = _temp;
  let t5;
  if ($[6] !== checkErrors) {
    t5 = () => {
      setIsLoggingIn(false);
      checkErrors();
    };
    $[6] = checkErrors;
    $[7] = t5;
  } else {
    t5 = $[7];
  }
  const handleLoginComplete = t5;
  let t6;
  if ($[8] === Symbol.for("react.memo_cache_sentinel")) {
    t6 = () => {
      setIsLoggingIn(true);
    };
    $[8] = t6;
  } else {
    t6 = $[8];
  }
  const handleLoginWithClaudeAI = t6;
  let t7;
  if ($[9] === Symbol.for("react.memo_cache_sentinel")) {
    t7 = value => {
      if (value === "login") {
        handleLoginWithClaudeAI();
      } else {
        onCancel();
      }
    };
    $[9] = t7;
  } else {
    t7 = $[9];
  }
  const handleLoginDialogSelect = t7;
  let t8;
  if ($[10] !== checkErrors) {
    t8 = () => {
      checkErrors();
    };
    $[10] = checkErrors;
    $[11] = t8;
  } else {
    t8 = $[11];
  }
  const handleStashComplete = t8;
  if (!currentError) {
    return null;
  }
  switch (currentError) {
    case "needsGitStash":
      {
        let t9;
        if ($[12] !== handleStashComplete) {
          t9 = <TeleportStash onStashAndContinue={handleStashComplete} onCancel={onCancel} />;
          $[12] = handleStashComplete;
          $[13] = t9;
        } else {
          t9 = $[13];
        }
        return t9;
      }
    case "needsLogin":
      {
        if (isLoggingIn) {
          let t9;
          if ($[14] !== handleLoginComplete) {
            t9 = <ConsoleOAuthFlow onDone={handleLoginComplete} mode="login" forceLoginMethod="claudeai" />;
            $[14] = handleLoginComplete;
            $[15] = t9;
          } else {
            t9 = $[15];
          }
          return t9;
        }
        let t9;
        if ($[16] === Symbol.for("react.memo_cache_sentinel")) {
          t9 = <Box flexDirection="column"><Text dimColor={true}>Teleport requires a Claude.ai account.</Text><Text dimColor={true}>Your Claude Pro/Max subscription will be used by Claude Code.</Text></Box>;
          $[16] = t9;
        } else {
          t9 = $[16];
        }
        let t10;
        if ($[17] === Symbol.for("react.memo_cache_sentinel")) {
          t10 = <Dialog title="Log in to Claude" onCancel={onCancel}>{t9}<Select options={[{
              label: "Login with Claude account",
              value: "login"
            }, {
              label: "Exit",
              value: "exit"
            }]} onChange={handleLoginDialogSelect} /></Dialog>;
          $[17] = t10;
        } else {
          t10 = $[17];
        }
        return t10;
      }
  }
}

/**
 * Gets current teleport errors that need to be resolved
 * @returns Set of teleport error types that need to be handled
 */
function _temp() {
  gracefulShutdownSync(0);
}
export async function getTeleportErrors(): Promise<Set<TeleportLocalErrorType>> {
  const errors = new Set<TeleportLocalErrorType>();
  const [needsLogin, isGitClean] = await Promise.all([checkNeedsClaudeAiLogin(), checkIsGitClean()]);
  if (needsLogin) {
    errors.add('needsLogin');
  }
  if (!isGitClean) {
    errors.add('needsGitStash');
  }
  return errors;
}
