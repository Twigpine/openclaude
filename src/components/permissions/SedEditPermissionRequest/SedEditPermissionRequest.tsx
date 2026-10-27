import { c as _c } from "react-compiler-runtime";
import { basename, relative } from 'path';
import React, { Suspense, use } from 'react';
import { FileEditToolDiff } from 'src/components/FileEditToolDiff.js';
import { getCwd } from 'src/utils/cwd.js';
import { isENOENT } from 'src/utils/errors.js';
import { detectEncodingForResolvedPath } from 'src/utils/fileRead.js';
import { getFsImplementation } from 'src/utils/fsOperations.js';
import { Text } from '../../../ink.js';
import { BashTool } from '../../../tools/BashTool/BashTool.js';
import { applySedSubstitution, type SedEditInfo } from '../../../tools/BashTool/sedEditParser.js';
import { FilePermissionDialog } from '../FilePermissionDialog/FilePermissionDialog.js';
import type { PermissionRequestProps } from '../PermissionRequest.js';
type SedEditPermissionRequestProps = PermissionRequestProps & {
  sedInfo: SedEditInfo;
};
type FileReadResult = {
  oldContent: string;
  fileExists: boolean;
};
export function SedEditPermissionRequest(t0) {
  const $ = _c(9);
  let props;
  let sedInfo;
  if ($[0] !== t0) {
    ({
      sedInfo,
      ...props
    } = t0);
    $[0] = t0;
    $[1] = props;
    $[2] = sedInfo;
  } else {
    props = $[1];
    sedInfo = $[2];
  }
  const {
    filePath
  } = sedInfo;
  let t1;
  if ($[3] !== filePath) {
    t1 = (async () => {
      const encoding = detectEncodingForResolvedPath(filePath);
      const raw = await getFsImplementation().readFile(filePath, {
        encoding
      });
      return {
        oldContent: raw.replaceAll("\r\n", "\n"),
        fileExists: true
      };
    })().catch(_temp);
    $[3] = filePath;
    $[4] = t1;
  } else {
    t1 = $[4];
  }
  const contentPromise = t1;
  let t2;
  if ($[5] !== contentPromise || $[6] !== props || $[7] !== sedInfo) {
    t2 = <Suspense fallback={null}><SedEditPermissionRequestInner sedInfo={sedInfo} contentPromise={contentPromise} {...props} /></Suspense>;
    $[5] = contentPromise;
    $[6] = props;
    $[7] = sedInfo;
    $[8] = t2;
  } else {
    t2 = $[8];
  }
  return t2;
}
function _temp(e) {
  if (!isENOENT(e)) {
    throw e;
  }
  return {
    oldContent: "",
    fileExists: false
  };
}
function SedEditPermissionRequestInner(t0) {
  const $ = _c(35);
  let contentPromise: Promise<{ oldContent: string; fileExists: boolean }>;
  let props;
  let sedInfo;
  if ($[0] !== t0) {
    ({
      sedInfo,
      contentPromise,
      ...props
    } = t0);
    $[0] = t0;
    $[1] = contentPromise;
    $[2] = props;
    $[3] = sedInfo;
  } else {
    contentPromise = $[1];
    props = $[2];
    sedInfo = $[3];
  }
  const {
    filePath
  } = sedInfo;
  const {
    oldContent,
    fileExists
  } = use(contentPromise);
  let t1;
  if ($[4] !== oldContent || $[5] !== sedInfo) {
    t1 = applySedSubstitution(oldContent, sedInfo);
    $[4] = oldContent;
    $[5] = sedInfo;
    $[6] = t1;
  } else {
    t1 = $[6];
  }
  const newContent = t1;
  let t2;
  bb0: {
    if (oldContent === newContent) {
      let t3;
      if ($[7] === Symbol.for("react.memo_cache_sentinel")) {
        t3 = [];
        $[7] = t3;
      } else {
        t3 = $[7];
      }
      t2 = t3;
      break bb0;
    }
    let t3;
    if ($[8] !== newContent || $[9] !== oldContent) {
      t3 = [{
        old_string: oldContent,
        new_string: newContent,
        replace_all: false
      }];
      $[8] = newContent;
      $[9] = oldContent;
      $[10] = t3;
    } else {
      t3 = $[10];
    }
    t2 = t3;
  }
  const edits = t2;
  let t3;
  bb1: {
    if (!fileExists) {
      t3 = "File does not exist";
      break bb1;
    }
    t3 = "Pattern did not match any content";
  }
  const noChangesMessage = t3;
  let t4;
  if ($[11] !== filePath || $[12] !== newContent) {
    t4 = input => {
      const parsed = BashTool.inputSchema.parse(input);
      return {
        ...parsed,
        _simulatedSedEdit: {
          filePath,
          newContent
        }
      };
    };
    $[11] = filePath;
    $[12] = newContent;
    $[13] = t4;
  } else {
    t4 = $[13];
  }
  const parseInput = t4;
  const t5 = props.toolUseConfirm;
  const t6 = props.toolUseContext;
  const t7 = props.onDone;
  const t8 = props.onReject;
  let t9;
  if ($[14] !== filePath) {
    t9 = relative(getCwd(), filePath);
    $[14] = filePath;
    $[15] = t9;
  } else {
    t9 = $[15];
  }
  let t10;
  if ($[16] !== filePath) {
    t10 = basename(filePath);
    $[16] = filePath;
    $[17] = t10;
  } else {
    t10 = $[17];
  }
  let t11;
  if ($[18] !== t10) {
    t11 = <Text>Do you want to make this edit to{" "}<Text bold={true}>{t10}</Text>?</Text>;
    $[18] = t10;
    $[19] = t11;
  } else {
    t11 = $[19];
  }
  let t12;
  if ($[20] !== edits || $[21] !== filePath || $[22] !== noChangesMessage) {
    t12 = edits.length > 0 ? <FileEditToolDiff file_path={filePath} edits={edits} /> : <Text dimColor={true}>{noChangesMessage}</Text>;
    $[20] = edits;
    $[21] = filePath;
    $[22] = noChangesMessage;
    $[23] = t12;
  } else {
    t12 = $[23];
  }
  let t13;
  if ($[24] !== filePath || $[25] !== parseInput || $[26] !== props.onDone || $[27] !== props.onReject || $[28] !== props.toolUseConfirm || $[29] !== props.toolUseContext || $[30] !== props.workerBadge || $[31] !== t11 || $[32] !== t12 || $[33] !== t9) {
    t13 = <FilePermissionDialog toolUseConfirm={t5} toolUseContext={t6} onDone={t7} onReject={t8} title="Edit file" subtitle={t9} question={t11} content={t12} path={filePath} completionType="str_replace_single" parseInput={parseInput} workerBadge={props.workerBadge} />;
    $[24] = filePath;
    $[25] = parseInput;
    $[26] = props.onDone;
    $[27] = props.onReject;
    $[28] = props.toolUseConfirm;
    $[29] = props.toolUseContext;
    $[30] = props.workerBadge;
    $[31] = t11;
    $[32] = t12;
    $[33] = t9;
    $[34] = t13;
  } else {
    t13 = $[34];
  }
  return t13;
}
