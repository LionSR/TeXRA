/**
 * Git author environment for a spawned process.
 *
 * When the calling session's workspace marks agent commits, these are merged
 * into the environment of every command {@link executeCommand} runs, so any
 * `git commit` carries the configured TeXRA identity. Read at spawn time from
 * that session's roots, not from a value applied once for the whole process:
 * a process holding several papers attributes each paper's commits by that
 * paper's own setting.
 */

import { WorkspaceStateKey } from '@shared/state/stateKeys';
import { readPlatformSetting } from '@utils/config/platformSettings';

/** Empty when commit marking is off. */
export function getGitAuthorEnv(): Record<string, string> {
  if (!readPlatformSetting<boolean>(WorkspaceStateKey.GIT_MARK_COMMITS)) {
    return {};
  }
  const name = readPlatformSetting<string>(WorkspaceStateKey.GIT_AUTHOR_NAME);
  const email = readPlatformSetting<string>(WorkspaceStateKey.GIT_AUTHOR_EMAIL);
  return {
    GIT_AUTHOR_NAME: name,
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: name,
    GIT_COMMITTER_EMAIL: email,
  };
}
