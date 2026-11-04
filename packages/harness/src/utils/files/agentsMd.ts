import * as path from 'node:path';

// Third-party imports
import { Effect, FileSystem } from 'effect';

import { withLogChannel } from '@logger/effectLog';
import { toErrorMessage } from '@utils/errors/errorMessage';

import { readNormalizedFile } from './fsDurability';
import { absentReason, entryExists } from './fsEntryExists';

const CHANNEL = 'agentsMd';

const AGENTS_FILE = 'AGENTS.md';

/**
 * Load the project instructions every agent follows: `AGENTS.md` at
 * `workspace` (the run's workspace root, when one is open), else the user's
 * own at `storageRoot`, the storage root the host opened (TeXRA's
 * `~/.texra`), where the user's skills and `mcp.json` are found too.
 * `AGENTS.md` is the one instructions file; no other name is read. Returns
 * the trimmed content or an empty string if none found.
 *
 * A missing file is the ordinary case and falls through to the next root;
 * every other filesystem failure (a permission error, an unreadable root)
 * fails the load with the file's path, because a silently absent
 * instructions file reads exactly like a run the user never wrote
 * instructions for.
 */
export const loadAgentsMd = Effect.fn('agentsMd.loadAgentsMd')(function* (
  workspace: string | undefined,
  storageRoot: string,
): Effect.fn.Return<string, Error, FileSystem.FileSystem> {
  const fs = yield* FileSystem.FileSystem;
  // Precedence order: the run's workspace, then the storage root. A root
  // whose file is absent or blank falls through to the next one.
  const candidates: Array<{ root: string; source: string }> = [];
  if (workspace) candidates.push({ root: workspace, source: 'workspace' });
  candidates.push({ root: storageRoot, source: 'user' });

  for (const { root, source } of candidates) {
    const file = path.join(root, AGENTS_FILE);
    // Absent, a dangling link included, is '' and falls through.
    const content = yield* Effect.gen(function* () {
      if (!(yield* entryExists(fs, file))) return '';
      return yield* readNormalizedFile(fs, file);
    }).pipe(
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
