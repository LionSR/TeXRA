/**
 * Reads git author settings from workspace state and pushes them
 * to the shared gitAuthorEnv module so that executeCommand injects
 * them into all spawned processes.
 *
 * Called at extension activation and after any git-author setting change.
 */
import { workspaceSM } from '@common/state';
import {
  applyGitAuthorSettings,
  type GitAuthorSettings,
  readGitAuthorSettingsFromState,
} from '@utils/system/gitAuthorSettings';

/** Read the current git author settings from workspace state with defaults. */
export function readGitAuthorSettings(): GitAuthorSettings {
  return readGitAuthorSettingsFromState(workspaceSM);
}

/** Apply settings and return them so callers can forward without re-reading. */
export function applyGitAuthorConfig(): ReturnType<
  typeof readGitAuthorSettings
> {
  const settings = readGitAuthorSettings();
  return applyGitAuthorSettings(settings);
}
