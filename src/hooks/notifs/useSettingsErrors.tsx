import { c as _c } from "react-compiler-runtime";
import { useEffect, useState } from 'react';
import { useNotifications } from 'src/context/notifications.js';
import { getIsRemoteMode } from '../../bootstrap/state.js';
import { getSettingsWithAllErrors } from '../../utils/settings/allErrors.js';
import type { ValidationError } from '../../utils/settings/validation.js';
import { useSettingsChange } from '../useSettingsChange.js';
const SETTINGS_ERRORS_NOTIFICATION_KEY = 'settings-errors';
export function useSettingsErrors() {
  const $ = _c(6);
  const {
    addNotification,
    removeNotification
  } = useNotifications();
  const [errors_0, setErrors] = useState(_temp);
  let t0;
  if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
    t0 = () => {
      const {
        errors: errors_1
      } = getSettingsWithAllErrors();
      setErrors(errors_1);
    };
    $[0] = t0;
  } else {
    t0 = $[0];
  }
  const handleSettingsChange = t0;
  useSettingsChange(handleSettingsChange);
  let t1;
  let t2;
  if ($[1] !== addNotification || $[2] !== errors_0 || $[3] !== removeNotification) {
    t1 = () => {
      if (getIsRemoteMode()) {
        return;
      }
      if (errors_0.length > 0) {
        const message = `Found ${errors_0.length} settings ${errors_0.length === 1 ? "issue" : "issues"} · /doctor for details`;
        addNotification({
          key: SETTINGS_ERRORS_NOTIFICATION_KEY,
          text: message,
          color: "warning",
          priority: "high",
          timeoutMs: 60000
        });
      } else {
        removeNotification(SETTINGS_ERRORS_NOTIFICATION_KEY);
      }
    };
    t2 = [errors_0, addNotification, removeNotification];
    $[1] = addNotification;
    $[2] = errors_0;
    $[3] = removeNotification;
    $[4] = t1;
    $[5] = t2;
  } else {
    t1 = $[4];
    t2 = $[5];
  }
  useEffect(t1, t2);
  return errors_0;
}
function _temp() {
  const {
    errors
  } = getSettingsWithAllErrors();
  return errors;
}
