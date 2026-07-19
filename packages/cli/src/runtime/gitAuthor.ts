import type { ConfigProvider } from '@platform/interfaces';
import {
  applyGitAuthorSettings,
  readGitAuthorSettingsFromState,
} from '@utils/system/gitAuthorSettings';

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
  applyGitAuthorSettings(readGitAuthorSettingsFromState(config));
}
