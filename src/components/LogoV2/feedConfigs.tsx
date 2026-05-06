import figures from 'figures';
import { homedir } from 'os';
import * as React from 'react';
import { Box, Text } from '../../ink.js';
import type { Step } from '../../projectOnboardingState.js';
import { formatCreditAmount, getCachedReferrerReward } from '../../services/api/referral.js';
import type { LogOption } from '../../types/logs.js';
import { getCwd } from '../../utils/cwd.js';
import { formatRelativeTimeAgo } from '../../utils/format.js';
import type { FeedConfig, FeedLine } from './Feed.js';
export function createRecentActivityFeed(activities: LogOption[]): FeedConfig {
  const lines: FeedLine[] = activities.map(log => {
    const time = formatRelativeTimeAgo(log.modified);
    const description = log.summary && log.summary !== 'No prompt' ? log.summary : log.firstPrompt;
    return {
      text: description || '',
      timestamp: time
    };
  });
  return {
    title: '最近活动',
    lines,
    footer: lines.length > 0 ? '输入 /resume 查看更多' : undefined,
    emptyMessage: '暂无最近活动'
  };
}
export function createWhatsNewFeed(releaseNotes: string[]): FeedConfig {
  const lines: FeedLine[] = releaseNotes.map(note => {
    if ("external" === 'ant') {
      const match = note.match(/^(\d+\s+\w+\s+ago)\s+(.+)$/);
      if (match) {
        return {
          timestamp: match[1],
          text: match[2] || ''
        };
      }
    }
    return {
      text: note
    };
  });
  const emptyMessage = "external" === 'ant' ? '无法获取最新 Spark 内部提交' : '请查看 Spark Code 更新日志';
  return {
    title: "external" === 'ant' ? "最新动态 [仅 ANT: 最新 CC 提交]" : '最新动态',
    lines,
    footer: lines.length > 0 ? '输入 /release-notes 查看更多' : undefined,
    emptyMessage
  };
}
export function createProjectOnboardingFeed(steps: Step[]): FeedConfig {
  const enabledSteps = steps.filter(({
    isEnabled
  }) => isEnabled).sort((a, b) => Number(a.isComplete) - Number(b.isComplete));
  const lines: FeedLine[] = enabledSteps.map(({
    text,
    isComplete
  }) => {
    const checkmark = isComplete ? `${figures.tick} ` : '';
    return {
      text: `${checkmark}${text}`
    };
  });
  const warningText = getCwd() === homedir() ? '提示：你当前在用户主目录中启动了 Spark Code。建议在项目目录中启动，以获得更好体验。' : undefined;
  if (warningText) {
    lines.push({
      text: warningText
    });
  }
  return {
    title: '入门提示',
    lines
  };
}
export function createGuestPassesFeed(): FeedConfig {
  const reward = getCachedReferrerReward();
  const subtitle = reward ? `分享 Spark Code，可获得 ${formatCreditAmount(reward)} 额外使用额度` : '把 Spark Code 分享给朋友';
  return {
    title: '3 张访客通行证',
    lines: [],
    customContent: {
      content: <>
          <Box marginY={1}>
            <Text color="claude">[✻] [✻] [✻]</Text>
          </Box>
          <Text dimColor>{subtitle}</Text>
        </>,
      width: 48
    },
    footer: '/passes'
  };
}
