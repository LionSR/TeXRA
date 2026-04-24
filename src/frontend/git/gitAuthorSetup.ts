/**
 * Reads git author settings from workspace state and pushes them
 * to the shared gitAuthorEnv module so that executeCommand injects
 * them into all spawned processes.
 *
 * Called at extension activation and after any git-author setting change.
 */
import { WorkspaceStateKey, workspaceSM } from '@common/state';
import {
  DEFAULT_GIT_AUTHOR_NAME,
  DEFAULT_GIT_AUTHOR_EMAIL,
  DEFAULT_GIT_MARK_COMMITS,
} from '@shared/constants/git';
import { setWorktreeSupportEnabled } from '@tools/worktreeConfig';
import { setGitAuthorEnv } from '@utils/system/gitAuthorEnv';

/** Read the current git author settings from workspace state with defaults. */
export function readGitAuthorSettings(): {
  markCommits: boolean;
  authorName: string;
  authorEmail: string;
  worktreeSupport: boolean;
} {
  return {
    markCommits: workspaceSM.get<boolean>(
      WorkspaceStateKey.GIT_MARK_COMMITS,
      DEFAULT_GIT_MARK_COMMITS,
    ),
    authorName:
      workspaceSM.get<string>(WorkspaceStateKey.GIT_AUTHOR_NAME) ||
      DEFAULT_GIT_AUTHOR_NAME,
    authorEmail:
      workspaceSM.get<string>(WorkspaceStateKey.GIT_AUTHOR_EMAIL) ||
      DEFAULT_GIT_AUTHOR_EMAIL,
    worktreeSupport: workspaceSM.get<boolean>(
      WorkspaceStateKey.GIT_WORKTREE_SUPPORT,
      false,
    ),
  };
}

/** Apply settings and return them so callers can forward without re-reading. */
export function applyGitAuthorConfig(): ReturnType<
  typeof readGitAuthorSettings
> {
  const settings = readGitAuthorSettings();
  if (!settings.markCommits) {
    setGitAuthorEnv({});
  } else {
    const { authorName, authorEmail } = settings;
    setGitAuthorEnv({
      GIT_AUTHOR_NAME: authorName,
      GIT_AUTHOR_EMAIL: authorEmail,
      GIT_COMMITTER_NAME: authorName,
      GIT_COMMITTER_EMAIL: authorEmail,
    });
  }
  setWorktreeSupportEnabled(settings.worktreeSupport);
  return settings;
}
