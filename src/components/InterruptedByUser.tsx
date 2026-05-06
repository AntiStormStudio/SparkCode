import { c as _c } from "react/compiler-runtime";
import * as React from 'react';
import { Text } from '../ink.js';
export function InterruptedByUser() {
  const $ = _c(1);
  let t0;
  if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
    t0 = <><Text dimColor={true}>已中断 </Text>{false ? <Text dimColor={true}>· [ANT-ONLY] /issue 报告模型问题</Text> : <Text dimColor={true}>· 那么应该让 Claude 做什么？</Text>}</>;
    $[0] = t0;
  } else {
    t0 = $[0];
  }
  return t0;
}