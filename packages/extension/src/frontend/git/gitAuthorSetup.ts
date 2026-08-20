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
} from '@utils/system/gitAuthorSettings';

export function applyGitAuthorConfig(): void {
  applyGitAuthorSettings(
    readGitAuthorSettingsFromState(platform().workspaceState),
  );
}
