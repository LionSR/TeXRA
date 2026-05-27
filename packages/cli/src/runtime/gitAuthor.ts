import { WorkspaceStateKey } from '@common/state/stateKeys';
import {
  DEFAULT_GIT_AUTHOR_EMAIL,
  DEFAULT_GIT_AUTHOR_NAME,
  DEFAULT_GIT_MARK_COMMITS,
} from '@shared/constants/git';
import { setGitAuthorEnv } from '@utils/system/gitAuthorEnv';

import type { ConfigProvider } from '@platform/interfaces/config';

/**
 * Mirror the extension's git-author marking for the CLI: by default, commits
 * made by spawned `git` processes are attributed to the TeXRA identity so that
 * agent-authored commits are distinguishable from the user's own.
 *
 * Read from `.texra/config.json` (the CLI's platform config) so it can be
 * turned off or customized without code changes:
 *
 * - `texra.git.markCommits` (default `true`) — enable/disable the marking.
 * - `texra.git.authorName` / `texra.git.authorEmail` — override the identity.
 */
export function applyCliGitAuthorConfig(config: ConfigProvider): void {
  const markCommits = config.get<boolean>(
    WorkspaceStateKey.GIT_MARK_COMMITS,
    DEFAULT_GIT_MARK_COMMITS,
  );
  if (!markCommits) {
    setGitAuthorEnv({});
    return;
  }
  const authorName =
    config.get<string>(WorkspaceStateKey.GIT_AUTHOR_NAME, '') ||
    DEFAULT_GIT_AUTHOR_NAME;
  const authorEmail =
    config.get<string>(WorkspaceStateKey.GIT_AUTHOR_EMAIL, '') ||
    DEFAULT_GIT_AUTHOR_EMAIL;
  setGitAuthorEnv({
    GIT_AUTHOR_NAME: authorName,
    GIT_AUTHOR_EMAIL: authorEmail,
    GIT_COMMITTER_NAME: authorName,
    GIT_COMMITTER_EMAIL: authorEmail,
  });
}
