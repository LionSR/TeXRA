/**
 * Git author environment for a spawned process.
 *
 * When the calling session's workspace marks agent commits, these are merged
 * into the environment of every command {@link executeCommand} runs, so any
 * `git commit` carries the configured TeXRA identity. Read at spawn time from
 * the setting slots the caller named on the command options, not from a value
 * applied once for the whole process: a process holding several papers
 * attributes each paper's commits by that paper's own setting.
 */

import type { SettingsStores } from '@shared/config/settingsAccess';
import { WorkspaceStateKey } from '@shared/state/stateKeys';
import { readSettingFrom } from '@utils/config/platformSettings';

/** Empty when the caller has no workspace, or when commit marking is off. */
export function getGitAuthorEnv(
  settings: SettingsStores | undefined,
): Record<string, string> {
  if (!settings) return {};
  if (!readSettingFrom<boolean>(settings, WorkspaceStateKey.GIT_MARK_COMMITS)) {
    return {};
  }
  const name = readSettingFrom<string>(
    settings,
    WorkspaceStateKey.GIT_AUTHOR_NAME,
  );
  const email = readSettingFrom<string>(
    settings,
    WorkspaceStateKey.GIT_AUTHOR_EMAIL,
  );
  return {
    GIT_AUTHOR_NAME: name,
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: name,
    GIT_COMMITTER_EMAIL: email,
  };
}
