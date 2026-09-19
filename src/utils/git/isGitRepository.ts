/**
 * Probe for "is this path inside a git working tree?". Interrupting the
 * calling fiber kills the `git` process instead of abandoning it —
 * `executeCommand` owns that teardown, so nothing is threaded through here.
 *
 * VS Code-free, and it reads no ambient state: `rootPath` is the folder to
 * probe and `settings` the slots the spawn's git identity is read from, both
 * carried as data by whoever holds them — the availability checks in
 * EXTERNAL_TOOL_DEFS take the asking host's workspace root, and the
 * `texra.isGitRepository` command takes the session's (#12421). `undefined`
 * means "no folder", which is not a repository.
 */

import { Effect } from 'effect';

import type { SettingsStores } from '@shared/config/settingsAccess';
import { executeCommand } from '@utils/system/execUtils';

export function isGitRepository(
  rootPath: string | undefined,
  settings: SettingsStores | undefined,
): Effect.Effect<boolean> {
  if (!rootPath) return Effect.succeed(false);
  return executeCommand(['git', 'rev-parse', '--is-inside-work-tree'], {
    cwd: rootPath,
    settings,
    timeout: 5_000,
  }).pipe(Effect.map((result) => result.success && result.stdout === 'true'));
}
