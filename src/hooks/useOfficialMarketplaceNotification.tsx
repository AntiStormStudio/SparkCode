import * as React from 'react';
import type { Notification } from '../context/notifications.js';
import { Text } from '../ink.js';
import { logForDebugging } from '../utils/debug.js';
import { checkAndInstallOfficialMarketplace } from '../utils/plugins/officialMarketplaceStartupCheck.js';
import { useStartupNotification } from './notifs/useStartupNotification.js';

/**
 * Hook that handles official marketplace auto-installation and shows
 * notifications for success/failure in the bottom right of the REPL.
 */
export function useOfficialMarketplaceNotification() {
  useStartupNotification(_temp);
}
async function _temp() {
  const result = await checkAndInstallOfficialMarketplace();
  const notifs = [];
  if (result.configSaveFailed) {
    logForDebugging("Showing marketplace config save failure notification");
    notifs.push({
      key: "marketplace-config-save-failed",
      jsx: <Text color="error">保存 marketplace 重试信息失败 · 请检查 ~/.claude.json 权限</Text>,
      priority: "immediate",
      timeoutMs: 10000
    });
  }
  if (result.installed) {
    logForDebugging("Showing marketplace installation success notification");
    notifs.push({
      key: "marketplace-installed",
      jsx: <Text color="success">✓ Anthropic 插件市场已安装 · 用 /plugin 查看可用插件</Text>,
      priority: "immediate",
      timeoutMs: 7000
    });
  } else {
    if (result.skipped && result.reason === "unknown") {
      logForDebugging("Showing marketplace installation failure notification");
      notifs.push({
        key: "marketplace-install-failed",
        jsx: <Text color="warning">安装 Anthropic marketplace 失败 · 下次启动时会重试</Text>,
        priority: "immediate",
        timeoutMs: 8000
      });
    }
  }
  return notifs;
}
