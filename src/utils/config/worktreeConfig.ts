/**
 * Whether delegated subagents may run in a git worktree of their own
 * (`working_directory`); off by default, in which case subagents operate in
 * the workspace root only. Read from the calling session's workspace each
 * time it is checked, so a process holding several papers honors each paper's
 * own opt-in.
 */

import { WorkspaceStateKey } from '@shared/state/stateKeys';
import { readPlatformSetting } from '@utils/config/platformSettings';

export function isWorktreeSupportEnabled(): boolean {
  return readPlatformSetting<boolean>(WorkspaceStateKey.GIT_WORKTREE_SUPPORT);
}
