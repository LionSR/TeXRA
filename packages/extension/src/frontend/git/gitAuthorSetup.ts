/**
 * Reads git author settings from workspace state and pushes them
 * to the shared gitAuthorEnv module so that executeCommand injects
 * them into all spawned processes.
 *
 * Called at extension activation and after any git-author setting change.
 */
import { platform } from '@platform/platform';
import {
  applyGitAuthorSettings,
  readGitAuthorSettingsFromState,
  type GitAuthorSettings,
} from '@utils/system/gitAuthorSettings';

/** Apply settings and return them so callers can forward without re-reading. */
export function applyGitAuthorConfig(): GitAuthorSettings {
  return applyGitAuthorSettings(
    readGitAuthorSettingsFromState(platform().workspaceState),
  );
}
