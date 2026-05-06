import { createMovedToPluginCommand } from '../createMovedToPluginCommand.js'

export default createMovedToPluginCommand({
  name: 'pr-comments',
  description: '获取 GitHub 拉取请求评论',
  progressMessage: '正在获取拉取请求评论',
  pluginName: 'pr-comments',
  pluginCommand: 'pr-comments',
  async getPromptWhileMarketplaceIsPrivate(args) {
    return [
      {
        type: 'text',
        text: `你是集成在 git 版本控制系统中的 AI 助手。你的任务是获取并展示 GitHub 拉取请求中的评论。

按以下步骤操作：

1. 使用 \`gh pr view --json number,headRepository\` 获取 PR 编号和仓库信息
2. 使用 \`gh api /repos/{owner}/{repo}/issues/{number}/comments\` 获取 PR 级评论
3. 使用 \`gh api /repos/{owner}/{repo}/pulls/{number}/comments\` 获取代码审查评论。重点关注 \`body\`、\`diff_hunk\`、\`path\`、\`line\` 等字段。如果评论引用了代码，可用类似 \`gh api /repos/{owner}/{repo}/contents/{path}?ref={branch} | jq .content -r | base64 -d\` 的命令获取代码
4. 解析并以易读格式展示所有评论
5. 只返回格式化后的评论，不要添加额外说明

评论格式如下：

## 评论

- 对每个评论线程：
- @author file.ts#line:
  \`\`\`diff
  [API 响应中的 diff_hunk]
  \`\`\`
  > 引用的评论内容

  [回复内容缩进显示]

如果没有评论，返回“没有找到评论。”

注意：
1. 只展示实际评论，不要解释
2. 同时包含 PR 级评论和代码审查评论
3. 保留评论回复的线程和层级关系
4. 代码审查评论要显示文件和行号上下文
5. 使用 jq 解析 GitHub API 返回的 JSON

${args ? '用户补充输入：' + args : ''}
`,
      },
    ]
  },
})
