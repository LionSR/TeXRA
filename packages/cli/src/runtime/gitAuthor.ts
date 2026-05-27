import { WorkspaceStateKey } from '@common/state/stateKeys';
import {
  DEFAULT_GIT_AUTHOR_EMAIL,
  DEFAULT_GIT_AUTHOR_NAME,
  DEFAULT_GIT_MARK_COMMITS,
} from '@shared/constants/git';
import { applyGitAuthorSettings } from '@utils/system/gitAuthorSettings';

import type { ConfigProvider } from '@platform/interfaces/config';

/**
 * Mirror the extension's git-author marking for the CLI: by default, commits
 * made by spawned `git` processes are attributed to the TeXRA identity so that
 * agent-authored commits are distinguishable from the user's own.
 *
 * The extension reads these from workspace state; the CLI reads the same keys
 * from `.texra/config.json` (the CLI's platform config) so they can be turned
 * off or customized without code changes:
 *
 * - `texra.git.markCommits` (default `true`) — enable/disable the marking.
 * - `texra.git.authorName` / `texra.git.authorEmail` — override the identity.
 * - `texra.git.worktreeSupport` (default `false`) — subagent worktree opt-in.
 */
export function applyCliGitAuthorConfig(config: ConfigProvider): void {
  applyGitAuthorSettings({
    markCommits: config.get<boolean>(
      WorkspaceStateKey.GIT_MARK_COMMITS,
      DEFAULT_GIT_MARK_COMMITS,
    ),
    authorName:
      config.get<string>(WorkspaceStateKey.GIT_AUTHOR_NAME, '') ||
      DEFAULT_GIT_AUTHOR_NAME,
    authorEmail:
      config.get<string>(WorkspaceStateKey.GIT_AUTHOR_EMAIL, '') ||
      DEFAULT_GIT_AUTHOR_EMAIL,
    worktreeSupport: config.get<boolean>(
      WorkspaceStateKey.GIT_WORKTREE_SUPPORT,
      false,
    ),
  });
}
