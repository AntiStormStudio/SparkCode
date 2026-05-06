import React, { useEffect, useState } from 'react';
import type { CommandResultDisplay } from 'src/commands.js';
import { logEvent } from 'src/services/analytics/index.js';
import { logForDebugging } from 'src/utils/debug.js';
import { Box, Text } from '../ink.js';
import { execFileNoThrow } from '../utils/execFileNoThrow.js';
import { getPlansDirectory } from '../utils/plans.js';
import { setCwd } from '../utils/Shell.js';
import { cleanupWorktree, getCurrentWorktreeSession, keepWorktree, killTmuxSession } from '../utils/worktree.js';
import { Select } from './CustomSelect/select.js';
import { Dialog } from './design-system/Dialog.js';
import { Spinner } from './Spinner.js';

// Inline require breaks the cycle this file would otherwise close:
// sessionStorage → commands → exit → ExitFlow → here. All call sites
// are inside callbacks, so the lazy require never sees an undefined import.
function recordWorktreeExit(): void {
  /* eslint-disable @typescript-eslint/no-require-imports */
  ;
  (require('../utils/sessionStorage.js') as typeof import('../utils/sessionStorage.js')).saveWorktreeState(null);
  /* eslint-enable @typescript-eslint/no-require-imports */
}
type Props = {
  onDone: (result?: string, options?: {
    display?: CommandResultDisplay;
  }) => void;
  onCancel?: () => void;
};
export function WorktreeExitDialog({
  onDone,
  onCancel
}: Props): React.ReactNode {
  const [status, setStatus] = useState<'loading' | 'asking' | 'keeping' | 'removing' | 'done'>('loading');
  const [changes, setChanges] = useState<string[]>([]);
  const [commitCount, setCommitCount] = useState<number>(0);
  const [resultMessage, setResultMessage] = useState<string | undefined>();
  const worktreeSession = getCurrentWorktreeSession();
  useEffect(() => {
    async function loadChanges() {
      let changeLines: string[] = [];
      const gitStatus = await execFileNoThrow('git', ['status', '--porcelain']);
      if (gitStatus.stdout) {
        changeLines = gitStatus.stdout.split('\n').filter(_ => _.trim() !== '');
        setChanges(changeLines);
      }

      // Check for commits to eject
      if (worktreeSession) {
        // Get commits in worktree that are not in original branch
        const {
          stdout: commitsStr
        } = await execFileNoThrow('git', ['rev-list', '--count', `${worktreeSession.originalHeadCommit}..HEAD`]);
        const count = parseInt(commitsStr.trim()) || 0;
        setCommitCount(count);

        // If no changes and no commits, clean up silently
        if (changeLines.length === 0 && count === 0) {
          setStatus('removing');
          void cleanupWorktree().then(() => {
            process.chdir(worktreeSession.originalCwd);
            setCwd(worktreeSession.originalCwd);
            recordWorktreeExit();
            getPlansDirectory.cache.clear?.();
            setResultMessage('Worktree removed (no changes)');
          }).catch(error => {
            logForDebugging(`Failed to clean up worktree: ${error}`, {
              level: 'error'
            });
            setResultMessage('Worktree cleanup failed, exiting anyway');
          }).then(() => {
            setStatus('done');
          });
          return;
        } else {
          setStatus('asking');
        }
      }
    }
    void loadChanges();
    // eslint-disable-next-line react-hooks/exhaustive-deps
    // biome-ignore lint/correctness/useExhaustiveDependencies: intentional
  }, [worktreeSession]);
  useEffect(() => {
    if (status === 'done') {
      onDone(resultMessage);
    }
  }, [status, onDone, resultMessage]);
  if (!worktreeSession) {
    onDone('No active worktree session found', {
      display: 'system'
    });
    return null;
  }
  if (status === 'loading' || status === 'done') {
    return null;
  }
  async function handleSelect(value: string) {
    if (!worktreeSession) return;
    const hasTmux = Boolean(worktreeSession.tmuxSessionName);
    if (value === 'keep' || value === 'keep-with-tmux') {
      setStatus('keeping');
      logEvent('tengu_worktree_kept', {
        commits: commitCount,
        changed_files: changes.length
      });
      await keepWorktree();
      process.chdir(worktreeSession.originalCwd);
      setCwd(worktreeSession.originalCwd);
      recordWorktreeExit();
      getPlansDirectory.cache.clear?.();
      if (hasTmux) {
        setResultMessage(`Worktree kept. Your work is saved at ${worktreeSession.worktreePath} on branch ${worktreeSession.worktreeBranch}. Reattach to tmux session with: tmux attach -t ${worktreeSession.tmuxSessionName}`);
      } else {
        setResultMessage(`Worktree kept. Your work is saved at ${worktreeSession.worktreePath} on branch ${worktreeSession.worktreeBranch}`);
      }
      setStatus('done');
    } else if (value === 'keep-kill-tmux') {
      setStatus('keeping');
      logEvent('tengu_worktree_kept', {
        commits: commitCount,
        changed_files: changes.length
      });
      if (worktreeSession.tmuxSessionName) {
        await killTmuxSession(worktreeSession.tmuxSessionName);
      }
      await keepWorktree();
      process.chdir(worktreeSession.originalCwd);
      setCwd(worktreeSession.originalCwd);
      recordWorktreeExit();
      getPlansDirectory.cache.clear?.();
      setResultMessage(`Worktree kept at ${worktreeSession.worktreePath} on branch ${worktreeSession.worktreeBranch}. Tmux session terminated.`);
      setStatus('done');
    } else if (value === 'remove' || value === 'remove-with-tmux') {
      setStatus('removing');
      logEvent('tengu_worktree_removed', {
        commits: commitCount,
        changed_files: changes.length
      });
      if (worktreeSession.tmuxSessionName) {
        await killTmuxSession(worktreeSession.tmuxSessionName);
      }
      try {
        await cleanupWorktree();
        process.chdir(worktreeSession.originalCwd);
        setCwd(worktreeSession.originalCwd);
        recordWorktreeExit();
        getPlansDirectory.cache.clear?.();
      } catch (error) {
        logForDebugging(`Failed to clean up worktree: ${error}`, {
          level: 'error'
        });
        setResultMessage('Worktree 清理失败，仍将退出');
        setStatus('done');
        return;
      }
      const tmuxNote = hasTmux ? ' Tmux 会话已终止。' : '';
      if (commitCount > 0 && changes.length > 0) {
        setResultMessage(`Worktree 已移除。已丢弃 ${commitCount} 个 commit 和未提交变更。${tmuxNote}`);
      } else if (commitCount > 0) {
        setResultMessage(`Worktree 已移除。已丢弃 ${worktreeSession.worktreeBranch} 上的 ${commitCount} 个 commit。${tmuxNote}`);
      } else if (changes.length > 0) {
        setResultMessage(`Worktree 已移除。未提交变更已丢弃。${tmuxNote}`);
      } else {
        setResultMessage(`Worktree 已移除。${tmuxNote}`);
      }
      setStatus('done');
    }
  }
  if (status === 'keeping') {
    return <Box flexDirection="row" marginY={1}>
        <Spinner />
        <Text>正在保留 worktree…</Text>
      </Box>;
  }
  if (status === 'removing') {
    return <Box flexDirection="row" marginY={1}>
        <Spinner />
        <Text>正在移除 worktree…</Text>
      </Box>;
  }
  const branchName = worktreeSession.worktreeBranch;
  const hasUncommitted = changes.length > 0;
  const hasCommits = commitCount > 0;
  let subtitle = '';
  if (hasUncommitted && hasCommits) {
    subtitle = `你在 ${branchName} 上有 ${changes.length} 个未提交文件和 ${commitCount} 个 commit。移除后都会丢失。`;
  } else if (hasUncommitted) {
    subtitle = `你有 ${changes.length} 个未提交文件。移除 worktree 后这些变更会丢失。`;
  } else if (hasCommits) {
    subtitle = `你在 ${branchName} 上有 ${commitCount} 个 commit。移除 worktree 会删除该分支。`;
  } else {
    subtitle = '你正在 worktree 中工作。保留它可继续在这里工作，移除则会清理它。';
  }
  function handleCancel() {
    if (onCancel) {
      // Abort exit and return to the session
      onCancel();
      return;
    }
    // Fallback: treat Escape as "keep" if no onCancel provided
    void handleSelect('keep');
  }
  const removeDescription = hasUncommitted || hasCommits ? '所有变更和 commit 都会丢失。' : '清理 worktree 目录。';
  const hasTmuxSession = Boolean(worktreeSession.tmuxSessionName);
  const options = hasTmuxSession ? [{
    label: '保留 worktree 和 tmux 会话',
    value: 'keep-with-tmux',
    description: `保留在 ${worktreeSession.worktreePath}。可用以下命令重新连接：tmux attach -t ${worktreeSession.tmuxSessionName}`
  }, {
    label: '保留 worktree，终止 tmux 会话',
    value: 'keep-kill-tmux',
    description: `保留 ${worktreeSession.worktreePath} 的 worktree，并终止 tmux 会话。`
  }, {
    label: '移除 worktree 和 tmux 会话',
    value: 'remove-with-tmux',
    description: removeDescription
  }] : [{
    label: '保留 worktree',
    value: 'keep',
    description: `保留在 ${worktreeSession.worktreePath}`
  }, {
    label: '移除 worktree',
    value: 'remove',
    description: removeDescription
  }];
  const defaultValue = hasTmuxSession ? 'keep-with-tmux' : 'keep';
  return <Dialog title="退出 worktree 会话" subtitle={subtitle} onCancel={handleCancel}>
      <Select defaultFocusValue={defaultValue} options={options} onChange={handleSelect} />
    </Dialog>;
}
