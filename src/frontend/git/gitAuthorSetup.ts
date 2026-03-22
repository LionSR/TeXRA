/**
 * Reads git author settings from workspace state and pushes them
 * to the shared gitAuthorEnv module so that executeCommand injects
 * them into all spawned processes.
 *
 * Called at extension activation and after any git-author setting change.
 */
import { WorkspaceStateKey, workspaceSM } from '@common/state';
import { setGitAuthorEnv } from '@utils/system/gitAuthorEnv';

export function applyGitAuthorConfig(): void {
  const enabled = workspaceSM.get<boolean>(
    WorkspaceStateKey.GIT_MARK_COMMITS,
    false,
  );
  if (!enabled) {
    setGitAuthorEnv({});
    return;
  }
  const name =
    workspaceSM.get<string>(WorkspaceStateKey.GIT_AUTHOR_NAME) || 'TeXRA';
  const email =
    workspaceSM.get<string>(WorkspaceStateKey.GIT_AUTHOR_EMAIL) ||
    'texra@users.noreply.github.com';
  setGitAuthorEnv({
    GIT_AUTHOR_NAME: name,
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: name,
    GIT_COMMITTER_EMAIL: email,
  });
}
