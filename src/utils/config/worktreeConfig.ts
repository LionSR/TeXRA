/**
 * Whether delegated subagents may run in a git worktree of their own
 * (`working_directory`); off by default, in which case subagents operate in
 * the workspace root only. Read from the slots the caller holds each time it
 * is checked, so a process holding several papers honors each paper's own
 * opt-in.
 */

import type { SettingsStores } from '@shared/config/settingsAccess';
import { WorkspaceStateKey } from '@shared/state/stateKeys';
import { readSettingFrom } from '@utils/config/platformSettings';

export function isWorktreeSupportEnabled(stores: SettingsStores): boolean {
  return readSettingFrom<boolean>(
    stores,
    WorkspaceStateKey.GIT_WORKTREE_SUPPORT,
  );
}
