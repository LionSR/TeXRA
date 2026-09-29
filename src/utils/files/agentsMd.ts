import * as path from 'node:path';

// Third-party imports
import { Effect, FileSystem } from 'effect';

import { withLogChannel } from '@logger/effectLog';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { safeHomedir } from '@utils/system/platformPaths';

import { readNormalizedFile } from './fsDurability';
import { entryExists } from './fsEntryExists';

const CHANNEL = 'agentsMd';

const AGENTS_FILE = 'AGENTS.md';

/**
 * Load the project instructions every agent follows: `AGENTS.md` at
 * `workspace` (the run's workspace root, when one is open), else the user's
 * `~/.texra/AGENTS.md`. `AGENTS.md` is the one instructions file; TeXRA reads
 * no other name. Returns the trimmed content or an empty string if none found.
 *
 * A missing file is the ordinary case and answers with the empty string; every
 * other filesystem failure (a permission error, an unreadable root) is warned
 * about before it does, because a silently absent instructions file reads
 * exactly like a run the user never wrote instructions for.
 */
export const loadAgentsMd = (
  workspace: string | undefined,
): Effect.Effect<string, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    // Precedence order: the run's workspace, then the user's TeXRA home. A
    // root whose file is absent or blank falls through to the next one.
    const candidates: Array<{ root: string; source: string }> = [];
    if (workspace) candidates.push({ root: workspace, source: 'workspace' });
    const homeDir = safeHomedir();
    if (homeDir) {
      candidates.push({ root: path.join(homeDir, '.texra'), source: 'user' });
    }

    for (const { root, source } of candidates) {
      const file = path.join(root, AGENTS_FILE);
      if (!(yield* entryExists(fs, file))) continue;
      const trimmed = (yield* readNormalizedFile(fs, file)).trim();
      if (!trimmed) continue;
      yield* Effect.logDebug(`Loaded ${source} ${AGENTS_FILE}`).pipe(
        withLogChannel(CHANNEL),
      );
      return trimmed;
    }
    return '';
  }).pipe(
    Effect.catchIf(
      (error) => error.reason._tag === 'NotFound',
      () => Effect.succeed(''),
    ),
    Effect.catch((error) =>
      Effect.logWarning(
        `Failed to load ${AGENTS_FILE}: ${toErrorMessage(error)}`,
      ).pipe(withLogChannel(CHANNEL), Effect.as('')),
    ),
  );
