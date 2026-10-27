import * as path from 'node:path';

// Third-party imports
import { Effect, FileSystem } from 'effect';

import { withLogChannel } from '@logger/effectLog';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { safeHomedir } from '@utils/system/platformPaths';

import { readNormalizedFile } from './fsDurability';
import { absentReason } from './fsEntryExists';

const CHANNEL = 'agentsMd';

const AGENTS_FILE = 'AGENTS.md';

/**
 * Load the project instructions every agent follows: `AGENTS.md` at
 * `workspace` (the run's workspace root, when one is open), else the user's
 * `~/.texra/AGENTS.md`. `AGENTS.md` is the one instructions file; no other
 * name is read. Returns the trimmed content or an empty string if none found.
 *
 * A missing file is the ordinary case and falls through to the next root;
 * every other filesystem failure (a permission error, an unreadable root)
 * fails the load with the file's path, because a silently absent
 * instructions file reads exactly like a run the user never wrote
 * instructions for.
 */
export const loadAgentsMd = Effect.fn('agentsMd.loadAgentsMd')(function* (
  workspace: string | undefined,
): Effect.fn.Return<string, Error, FileSystem.FileSystem> {
  const fs = yield* FileSystem.FileSystem;
  // Precedence order: the run's workspace, then the user's `~/.texra`. A
  // root whose file is absent or blank falls through to the next one.
  const candidates: Array<{ root: string; source: string }> = [];
  if (workspace) candidates.push({ root: workspace, source: 'workspace' });
  const homeDir = safeHomedir();
  if (homeDir) {
    candidates.push({ root: path.join(homeDir, '.texra'), source: 'user' });
  }

  for (const { root, source } of candidates) {
    const file = path.join(root, AGENTS_FILE);
    // One read: absent (a dangling link or a non-directory parent
    // included) is '' and falls through.
    const content = yield* readNormalizedFile(fs, file).pipe(
      Effect.catchIf(absentReason, () => Effect.succeed('')),
      Effect.mapError(
        (error) =>
          new Error(`Failed to load ${file}: ${toErrorMessage(error)}`, {
            cause: error,
          }),
      ),
    );
    const trimmed = content.trim();
    if (!trimmed) continue;
    yield* Effect.logDebug(`Loaded ${source} ${AGENTS_FILE}`).pipe(
      withLogChannel(CHANNEL),
    );
    return trimmed;
  }
  return '';
});
