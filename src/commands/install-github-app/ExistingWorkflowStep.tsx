import { c as _c } from "react/compiler-runtime";
import React from 'react';
import { Select } from 'src/components/CustomSelect/index.js';
import { Box, Text } from '../../ink.js';
interface ExistingWorkflowStepProps {
  repoName: string;
  onSelectAction: (action: 'update' | 'skip' | 'exit') => void;
}
export function ExistingWorkflowStep(t0) {
  const $ = _c(16);
  const {
    repoName,
    onSelectAction
  } = t0;
  let t1;
  if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
    t1 = [{
      label: "将 workflow 文件更新到最新版本",
      value: "update"
    }, {
      label: "跳过 workflow 更新（只配置 secrets）",
      value: "skip"
    }, {
      label: "退出且不做更改",
      value: "exit"
    }];
    $[0] = t1;
  } else {
    t1 = $[0];
  }
  const options = t1;
  let t2;
  if ($[1] !== onSelectAction) {
    t2 = value => {
      onSelectAction(value as 'update' | 'skip' | 'exit');
    };
    $[1] = onSelectAction;
    $[2] = t2;
  } else {
    t2 = $[2];
  }
  const handleSelect = t2;
  let t3;
  if ($[3] !== onSelectAction) {
    t3 = () => {
      onSelectAction("exit");
    };
    $[3] = onSelectAction;
    $[4] = t3;
  } else {
    t3 = $[4];
  }
  const handleCancel = t3;
  let t4;
  if ($[5] === Symbol.for("react.memo_cache_sentinel")) {
    t4 = <Text bold={true}>发现已有 Workflow</Text>;
    $[5] = t4;
  } else {
    t4 = $[5];
  }
  let t5;
  if ($[6] !== repoName) {
    t5 = <Box flexDirection="column" marginBottom={1}>{t4}<Text dimColor={true}>仓库：{repoName}</Text></Box>;
    $[6] = repoName;
    $[7] = t5;
  } else {
    t5 = $[7];
  }
  let t6;
  if ($[8] === Symbol.for("react.memo_cache_sentinel")) {
    t6 = <Box flexDirection="column" marginBottom={1}><Text>Claude workflow 文件已存在于{" "}<Text color="claude">.github/workflows/claude.yml</Text></Text><Text dimColor={true}>你想怎么处理？</Text></Box>;
    $[8] = t6;
  } else {
    t6 = $[8];
  }
  let t7;
  if ($[9] !== handleCancel || $[10] !== handleSelect) {
    t7 = <Box flexDirection="column"><Select options={options} onChange={handleSelect} onCancel={handleCancel} /></Box>;
    $[9] = handleCancel;
    $[10] = handleSelect;
    $[11] = t7;
  } else {
    t7 = $[11];
  }
  let t8;
  if ($[12] === Symbol.for("react.memo_cache_sentinel")) {
    t8 = <Box marginTop={1}><Text dimColor={true}>查看最新 workflow 模板：{" "}<Text color="claude">https://github.com/anthropics/claude-code-action/blob/main/examples/claude.yml</Text></Text></Box>;
    $[12] = t8;
  } else {
    t8 = $[12];
  }
  let t9;
  if ($[13] !== t5 || $[14] !== t7) {
    t9 = <Box flexDirection="column" borderStyle="round" borderDimColor={true} paddingX={1}>{t5}{t6}{t7}{t8}</Box>;
    $[13] = t5;
    $[14] = t7;
    $[15] = t9;
  } else {
    t9 = $[15];
  }
  return t9;
}
