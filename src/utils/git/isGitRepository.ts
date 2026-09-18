/**
 * Async probe for "is this path inside a git working tree?". Callers inside
 * an Effect pass the fiber's abort signal so an interrupted probe kills the
 * `git` process instead of abandoning it.
 *
 * VS Code-free, and it reads no ambient state: `rootPath` is the folder to
 * probe and `settings` the slots the spawn's git identity is read from, both
 * carried as data by whoever holds them — the availability checks in
 * EXTERNAL_TOOL_DEFS take the asking host's workspace root, and the
 * `texra.isGitRepository` command takes the session's (#12421). `undefined`
 * means "no folder", which is not a repository.
 */

import type { SettingsStores } from '@shared/config/settingsAccess';
import { executeCommand } from '@utils/system/execUtils';

export async function isGitRepository(
  rootPath: string | undefined,
  settings: SettingsStores | undefined,
  signal?: AbortSignal,
): Promise<boolean> {
  if (!rootPath) return false;
  const result = await executeCommand(
    ['git', 'rev-parse', '--is-inside-work-tree'],
    { cwd: rootPath, settings, timeout: 5_000, signal },
  );
  return result.success && result.stdout === 'true';
}
