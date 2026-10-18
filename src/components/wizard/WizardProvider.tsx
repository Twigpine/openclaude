import { c as _c } from "react-compiler-runtime";
import React, { createContext, type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { useExitOnCtrlCDWithKeybindings } from '../../hooks/useExitOnCtrlCDWithKeybindings.js';
import type { WizardContextValue, WizardProviderProps } from './types.js';

// Use the default generic (Record<string, unknown>) for the context value; consumers
// that need a tighter type can supply it via useContext<WizardContextValue<T>>.
export const WizardContext = createContext<WizardContextValue | null>(null);
export function WizardProvider<T extends Record<string, unknown> = Record<string, unknown>>(t0: WizardProviderProps<T>): React.ReactNode {
  const $ = _c(38);
  const {
    steps,
    initialData: t1,
    onComplete,
    onCancel,
    children,
    title,
    showStepCounter: t2
  } = t0;
  let t3;
  if ($[0] !== t1) {
    t3 = t1 === undefined ? {} as T : t1;
    $[0] = t1;
    $[1] = t3;
  } else {
    t3 = $[1];
  }
  const initialData = t3;
  const showStepCounter = t2 === undefined ? true : t2;
  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  const [wizardData, setWizardData] = useState(initialData);
  const [isCompleted, setIsCompleted] = useState(false);
  let t4;
  if ($[2] === Symbol.for("react.memo_cache_sentinel")) {
    t4 = [];
    $[2] = t4;
  } else {
    t4 = $[2];
  }
  const [navigationHistory, setNavigationHistory] = useState<number[]>(t4);
  useExitOnCtrlCDWithKeybindings();
  let t5;
  let t6;
  if ($[3] !== isCompleted || $[4] !== onComplete || $[5] !== wizardData) {
    t5 = () => {
      if (isCompleted) {
        setNavigationHistory([]);
        onComplete(wizardData);
      }
    };
    t6 = [isCompleted, wizardData, onComplete];
    $[3] = isCompleted;
    $[4] = onComplete;
    $[5] = wizardData;
    $[6] = t5;
    $[7] = t6;
  } else {
    t5 = $[6];
    t6 = $[7];
  }
  useEffect(t5, t6);
  let t7;
  if ($[8] !== currentStepIndex || $[9] !== navigationHistory || $[10] !== steps.length) {
    t7 = () => {
      if (currentStepIndex < steps.length - 1) {
        if (navigationHistory.length > 0) {
          setNavigationHistory(prev => [...prev, currentStepIndex]);
        }
        setCurrentStepIndex(_temp);
      } else {
        setIsCompleted(true);
      }
    };
    $[8] = currentStepIndex;
    $[9] = navigationHistory;
    $[10] = steps.length;
    $[11] = t7;
  } else {
    t7 = $[11];
  }
  const goNext = t7;
  let t8;
  if ($[12] !== currentStepIndex || $[13] !== navigationHistory || $[14] !== onCancel) {
    t8 = () => {
      if (navigationHistory.length > 0) {
        const previousStep = navigationHistory[navigationHistory.length - 1];
        if (previousStep !== undefined) {
          setNavigationHistory(_temp2);
          setCurrentStepIndex(previousStep);
        }
      } else {
        if (currentStepIndex > 0) {
          setCurrentStepIndex(_temp3);
        } else {
          if (onCancel) {
            onCancel();
          }
        }
      }
    };
    $[12] = currentStepIndex;
    $[13] = navigationHistory;
    $[14] = onCancel;
    $[15] = t8;
  } else {
    t8 = $[15];
  }
  const goBack = t8;
  let t9;
  if ($[16] !== currentStepIndex || $[17] !== steps.length) {
    t9 = (index: number) => {
      if (index >= 0 && index < steps.length) {
        setNavigationHistory(prev_3 => [...prev_3, currentStepIndex]);
        setCurrentStepIndex(index);
      }
    };
    $[16] = currentStepIndex;
    $[17] = steps.length;
    $[18] = t9;
  } else {
    t9 = $[18];
  }
  const goToStep = t9;
  let t10;
  if ($[19] !== onCancel) {
    t10 = () => {
      setNavigationHistory([]);
      if (onCancel) {
        onCancel();
      }
    };
    $[19] = onCancel;
    $[20] = t10;
  } else {
    t10 = $[20];
  }
  const cancel = t10;
  let t11;
  if ($[21] === Symbol.for("react.memo_cache_sentinel")) {
    t11 = (updates: Partial<T>) => {
      setWizardData(prev_4 => ({
        ...prev_4,
        ...updates
      }));
    };
    $[21] = t11;
  } else {
    t11 = $[21];
  }
  const updateWizardData = t11;
  let t12;
  if ($[22] !== cancel || $[23] !== currentStepIndex || $[24] !== goBack || $[25] !== goNext || $[26] !== goToStep || $[27] !== showStepCounter || $[28] !== steps.length || $[29] !== title || $[30] !== wizardData) {
    t12 = {
      currentStepIndex,
      totalSteps: steps.length,
      wizardData,
      setWizardData,
      updateWizardData,
      goNext,
      goBack,
      goToStep,
      cancel,
      title,
      showStepCounter
    };
    $[22] = cancel;
    $[23] = currentStepIndex;
    $[24] = goBack;
    $[25] = goNext;
    $[26] = goToStep;
    $[27] = showStepCounter;
    $[28] = steps.length;
    $[29] = title;
    $[30] = wizardData;
    $[31] = t12;
  } else {
    t12 = $[31];
  }
  const contextValue = t12;
  const CurrentStepComponent = steps[currentStepIndex];
  if (!CurrentStepComponent || isCompleted) {
    return null;
  }
  let t13;
  if ($[32] !== CurrentStepComponent || $[33] !== children) {
    t13 = children || <CurrentStepComponent />;
    $[32] = CurrentStepComponent;
    $[33] = children;
    $[34] = t13;
  } else {
    t13 = $[34];
  }
  let t14;
  if ($[35] !== contextValue || $[36] !== t13) {
    t14 = <WizardContext.Provider value={contextValue}>{t13}</WizardContext.Provider>;
    $[35] = contextValue;
    $[36] = t13;
    $[37] = t14;
  } else {
    t14 = $[37];
  }
  return t14;
}
function _temp3(prev_2) {
  return prev_2 - 1;
}
function _temp2(prev_1) {
  return prev_1.slice(0, -1);
}
function _temp(prev_0) {
  return prev_0 + 1;
}
