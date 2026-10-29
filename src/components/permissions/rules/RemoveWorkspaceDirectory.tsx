import { c as _c } from "react-compiler-runtime";
import * as React from 'react';
import { Select } from '../../../components/CustomSelect/select.js';
import { PRODUCT_DISPLAY_NAME } from '../../../constants/product.js';
import { Box, Text } from '../../../ink.js';
import type { ToolPermissionContext } from '../../../Tool.js';
import { applyPermissionUpdate } from '../../../utils/permissions/PermissionUpdate.js';
import { Dialog } from '../../design-system/Dialog.js';
type Props = {
  directoryPath: string;
  onRemove: () => void;
  onCancel: () => void;
  permissionContext: ToolPermissionContext;
  setPermissionContext: (context: ToolPermissionContext) => void;
};
export function RemoveWorkspaceDirectory(t0) {
  const $ = _c(19);
  const {
    directoryPath,
    onRemove,
    onCancel,
    permissionContext,
    setPermissionContext
  } = t0;
  let t1;
  if ($[0] !== directoryPath || $[1] !== onRemove || $[2] !== permissionContext || $[3] !== setPermissionContext) {
    t1 = () => {
      const updatedContext = applyPermissionUpdate(permissionContext, {
        type: "removeDirectories",
        directories: [directoryPath],
        destination: "session"
      });
      setPermissionContext(updatedContext);
      onRemove();
    };
    $[0] = directoryPath;
    $[1] = onRemove;
    $[2] = permissionContext;
    $[3] = setPermissionContext;
    $[4] = t1;
  } else {
    t1 = $[4];
  }
  const handleRemove = t1;
  let t2;
  if ($[5] !== handleRemove || $[6] !== onCancel) {
    t2 = value => {
      if (value === "yes") {
        handleRemove();
      } else {
        onCancel();
      }
    };
    $[5] = handleRemove;
    $[6] = onCancel;
    $[7] = t2;
  } else {
    t2 = $[7];
  }
  const handleSelect = t2;
  let t3;
  if ($[8] !== directoryPath) {
    t3 = <Box marginX={2} flexDirection="column"><Text bold={true}>{directoryPath}</Text></Box>;
    $[8] = directoryPath;
    $[9] = t3;
  } else {
    t3 = $[9];
  }
  let t4;
  if ($[10] === Symbol.for("react.memo_cache_sentinel")) {
    t4 = <Text>{PRODUCT_DISPLAY_NAME} will no longer have access to files in this directory.</Text>;
    $[10] = t4;
  } else {
    t4 = $[10];
  }
  let t5;
  if ($[11] === Symbol.for("react.memo_cache_sentinel")) {
    t5 = [{
      label: "Yes",
      value: "yes"
    }, {
      label: "No",
      value: "no"
    }];
    $[11] = t5;
  } else {
    t5 = $[11];
  }
  let t6;
  if ($[12] !== handleSelect || $[13] !== onCancel) {
    t6 = <Select onChange={handleSelect} onCancel={onCancel} options={t5} />;
    $[12] = handleSelect;
    $[13] = onCancel;
    $[14] = t6;
  } else {
    t6 = $[14];
  }
  let t7;
  if ($[15] !== onCancel || $[16] !== t3 || $[17] !== t6) {
    t7 = <Dialog title="Remove directory from workspace?" onCancel={onCancel} color="error">{t3}{t4}{t6}</Dialog>;
    $[15] = onCancel;
    $[16] = t3;
    $[17] = t6;
    $[18] = t7;
  } else {
    t7 = $[18];
  }
  return t7;
}
