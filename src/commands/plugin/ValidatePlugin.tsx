import { c as _c } from "react/compiler-runtime";
import figures from 'figures';
import * as React from 'react';
import { useEffect } from 'react';
import { Box, Text } from '../../ink.js';
import { errorMessage } from '../../utils/errors.js';
import { logError } from '../../utils/log.js';
import { validateManifest } from '../../utils/plugins/validatePlugin.js';
type Props = {
  onComplete: (result?: string) => void;
  path?: string;
};
export function ValidatePlugin(t0) {
  const $ = _c(5);
  const {
    onComplete,
    path
  } = t0;
  let t1;
  let t2;
  if ($[0] !== onComplete || $[1] !== path) {
    t1 = () => {
      const runValidation = async function runValidation() {
        if (!path) {
          onComplete("用法：/plugin validate <path>\n\n验证插件或插件市场 manifest 文件/目录。\n\n示例：\n  /plugin validate .claude-plugin/plugin.json\n  /plugin validate /path/to/plugin-directory\n  /plugin validate .\n\n传入目录时，会自动验证 .claude-plugin/marketplace.json\n或 .claude-plugin/plugin.json（两者都存在时优先验证 marketplace）。\n\n也可从命令行运行：\n  claude plugin validate <path>");
          return;
        }
        ;
        try {
          const result = await validateManifest(path);
          let output = "";
          output = output + `正在验证 ${result.fileType} manifest：${result.filePath}\n\n`;
          output;
          if (result.errors.length > 0) {
            output = output + `${figures.cross} 发现 ${result.errors.length} 个错误：\n\n`;
            output;
            result.errors.forEach(error_0 => {
              output = output + `  ${figures.pointer} ${error_0.path}: ${error_0.message}\n`;
              output;
            });
            output = output + "\n";
            output;
          }
          if (result.warnings.length > 0) {
            output = output + `${figures.warning} 发现 ${result.warnings.length} 个警告：\n\n`;
            output;
            result.warnings.forEach(warning => {
              output = output + `  ${figures.pointer} ${warning.path}: ${warning.message}\n`;
              output;
            });
            output = output + "\n";
            output;
          }
          if (result.success) {
            if (result.warnings.length > 0) {
              output = output + `${figures.tick} 验证通过，但有警告\n`;
              output;
            } else {
              output = output + `${figures.tick} 验证通过\n`;
              output;
            }
            process.exitCode = 0;
          } else {
            output = output + `${figures.cross} 验证失败\n`;
            output;
            process.exitCode = 1;
          }
          onComplete(output);
        } catch (t3) {
          const error = t3;
          process.exitCode = 2;
          logError(error);
          onComplete(`${figures.cross} 验证时发生意外错误：${errorMessage(error)}`);
        }
      };
      runValidation();
    };
    t2 = [onComplete, path];
    $[0] = onComplete;
    $[1] = path;
    $[2] = t1;
    $[3] = t2;
  } else {
    t1 = $[2];
    t2 = $[3];
  }
  useEffect(t1, t2);
  let t3;
  if ($[4] === Symbol.for("react.memo_cache_sentinel")) {
    t3 = <Box flexDirection="column"><Text>正在验证...</Text></Box>;
    $[4] = t3;
  } else {
    t3 = $[4];
  }
  return t3;
}
