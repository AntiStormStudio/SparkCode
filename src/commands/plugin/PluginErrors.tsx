import { getPluginErrorMessage, type PluginError } from '../../types/plugin.js';
export function formatErrorMessage(error: PluginError): string {
  switch (error.type) {
    case 'path-not-found':
      return `${error.component} 路径不存在：${error.path}`;
    case 'git-auth-failed':
      return `Git ${error.authType.toUpperCase()} 认证失败：${error.gitUrl}`;
    case 'git-timeout':
      return `Git ${error.operation} 操作超时：${error.gitUrl}`;
    case 'network-error':
      return `访问 ${error.url} 时发生网络错误${error.details ? `：${error.details}` : ''}`;
    case 'manifest-parse-error':
      return `解析 manifest 失败：${error.manifestPath}：${error.parseError}`;
    case 'manifest-validation-error':
      return `manifest 无效：${error.manifestPath}：${error.validationErrors.join(', ')}`;
    case 'plugin-not-found':
      return `插件市场“${error.marketplace}”中未找到插件“${error.pluginId}”`;
    case 'marketplace-not-found':
      return `未找到插件市场“${error.marketplace}”`;
    case 'marketplace-load-failed':
      return `加载插件市场“${error.marketplace}”失败：${error.reason}`;
    case 'mcp-config-invalid':
      return `MCP 服务器“${error.serverName}”配置无效：${error.validationError}`;
    case 'mcp-server-suppressed-duplicate':
      {
        const dup = error.duplicateOf.startsWith('plugin:') ? `插件“${error.duplicateOf.split(':')[1] ?? '?'}”提供的服务器` : `已配置的“${error.duplicateOf}”`;
        return `已跳过 MCP 服务器“${error.serverName}”——命令/URL 与 ${dup} 相同`;
      }
    case 'hook-load-failed':
      return `从 ${error.hookPath} 加载 Hook 失败：${error.reason}`;
    case 'component-load-failed':
      return `从 ${error.path} 加载 ${error.component} 失败：${error.reason}`;
    case 'mcpb-download-failed':
      return `从 ${error.url} 下载 MCPB 失败：${error.reason}`;
    case 'mcpb-extract-failed':
      return `解压 MCPB ${error.mcpbPath} 失败：${error.reason}`;
    case 'mcpb-invalid-manifest':
      return `MCPB manifest 无效：${error.mcpbPath}：${error.validationError}`;
    case 'marketplace-blocked-by-policy':
      return error.blockedByBlocklist ? `插件市场“${error.marketplace}”已被企业策略阻止` : `插件市场“${error.marketplace}”不在允许列表中`;
    case 'dependency-unsatisfied':
      return error.reason === 'not-enabled' ? `依赖项“${error.dependency}”已停用` : `依赖项“${error.dependency}”未安装`;
    case 'lsp-config-invalid':
      return `LSP 服务器“${error.serverName}”配置无效：${error.validationError}`;
    case 'lsp-server-start-failed':
      return `LSP 服务器“${error.serverName}”启动失败：${error.reason}`;
    case 'lsp-server-crashed':
      return error.signal ? `LSP 服务器“${error.serverName}”因信号 ${error.signal} 崩溃` : `LSP 服务器“${error.serverName}”崩溃，退出码 ${error.exitCode ?? '未知'}`;
    case 'lsp-request-timeout':
      return `LSP 服务器“${error.serverName}”执行 ${error.method} 超时（${error.timeoutMs}ms）`;
    case 'lsp-request-failed':
      return `LSP 服务器“${error.serverName}”执行 ${error.method} 失败：${error.error}`;
    case 'plugin-cache-miss':
      return `插件“${error.plugin}”未缓存到 ${error.installPath}`;
    case 'generic-error':
      return error.error;
  }
  const _exhaustive: never = error;
  return getPluginErrorMessage(_exhaustive);
}
export function getErrorGuidance(error: PluginError): string | null {
  switch (error.type) {
    case 'path-not-found':
      return '请检查 manifest 或插件市场配置中的路径是否正确';
    case 'git-auth-failed':
      return error.authType === 'ssh' ? '请配置 SSH 密钥，或改用 HTTPS URL' : '请配置凭据，或改用 SSH URL';
    case 'git-timeout':
    case 'network-error':
      return '请检查网络连接后重试';
    case 'manifest-parse-error':
      return '请检查插件目录中的 manifest 文件语法';
    case 'manifest-validation-error':
      return '请检查 manifest 文件是否符合所需 schema';
    case 'plugin-not-found':
      return `插件可能不存在于插件市场“${error.marketplace}”中`;
    case 'marketplace-not-found':
      return error.availableMarketplaces.length > 0 ? `可用插件市场：${error.availableMarketplaces.join(', ')}` : '请先使用 /plugin marketplace add 添加插件市场';
    case 'mcp-config-invalid':
      return '请检查 .mcp.json 或 manifest 中的 MCP 服务器配置';
    case 'mcp-server-suppressed-duplicate':
      {
        // duplicateOf is "plugin:name:srv" when another plugin won dedup —
        // users can't remove plugin-provided servers from their MCP config,
        // so point them at the winning plugin instead.
        if (error.duplicateOf.startsWith('plugin:')) {
          const winningPlugin = error.duplicateOf.split(':')[1] ?? '另一个插件';
          return `如果想改用此插件的版本，请停用插件“${winningPlugin}”`;
        }
        return `如果想改用插件版本，请从 MCP 配置中移除“${error.duplicateOf}”`;
      }
    case 'hook-load-failed':
      return '请检查 hooks.json 文件语法和结构';
    case 'component-load-failed':
      return `请检查 ${error.component} 目录结构和文件权限`;
    case 'mcpb-download-failed':
      return '请检查网络连接以及 URL 是否可访问';
    case 'mcpb-extract-failed':
      return '请确认 MCPB 文件有效且未损坏';
    case 'mcpb-invalid-manifest':
      return '请联系插件作者修复无效的 manifest';
    case 'marketplace-blocked-by-policy':
      if (error.blockedByBlocklist) {
        return '此插件市场来源已被管理员明确阻止';
      }
      return error.allowedSources.length > 0 ? `允许的来源：${error.allowedSources.join(', ')}` : '请联系管理员配置允许的插件市场来源';
    case 'dependency-unsatisfied':
      return error.reason === 'not-enabled' ? `请启用“${error.dependency}”，或卸载“${error.plugin}”` : `请安装“${error.dependency}”，或卸载“${error.plugin}”`;
    case 'lsp-config-invalid':
      return '请检查插件 manifest 中的 LSP 服务器配置';
    case 'lsp-server-start-failed':
    case 'lsp-server-crashed':
    case 'lsp-request-timeout':
    case 'lsp-request-failed':
      return '请使用 --debug 查看 LSP 服务器日志详情';
    case 'plugin-cache-miss':
      return '请运行 /plugins 刷新插件缓存';
    case 'marketplace-load-failed':
    case 'generic-error':
      return null;
  }
  const _exhaustive: never = error;
  return null;
}
