import { c as _c } from "react/compiler-runtime";
import figures from 'figures';
import * as React from 'react';
import { Box, Text } from '../../ink.js';
import { getPluginTrustMessage } from '../../utils/plugins/marketplaceHelpers.js';
export function PluginTrustWarning() {
  const $ = _c(3);
  let t0;
  if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
    t0 = getPluginTrustMessage();
    $[0] = t0;
  } else {
    t0 = $[0];
  }
  const customMessage = t0;
  let t1;
  if ($[1] === Symbol.for("react.memo_cache_sentinel")) {
    t1 = <Text color="claude">{figures.warning} </Text>;
    $[1] = t1;
  } else {
    t1 = $[1];
  }
  let t2;
  if ($[2] === Symbol.for("react.memo_cache_sentinel")) {
    t2 = <Box marginBottom={1}>{t1}<Text dimColor={true} italic={true}>安装、更新或使用插件前，请确认你信任该插件。插件中可能包含 MCP 服务器、文件或其他软件，本项目无法保证它们会按预期工作，也无法保证它们不会变化。更多信息请查看每个插件的主页。{customMessage ? ` ${customMessage}` : ""}</Text></Box>;
    $[2] = t2;
  } else {
    t2 = $[2];
  }
  return t2;
}
