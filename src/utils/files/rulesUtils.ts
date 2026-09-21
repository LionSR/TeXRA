import * as path from 'node:path';

// Third-party imports
import { Effect, FileSystem } from 'effect';

import { withLogChannel } from '@logger/effectLog';
import { createLog } from '@logger/logUtils';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { safeHomedir } from '@utils/system/platformPaths';

import { readNormalizedFile } from './fsDurability';
import { entryExists } from './fsEntryExists';

const CHANNEL = 'rulesUtils';
const log = createLog(CHANNEL);

const RULES_FILE = '.texrarules';

/**
 * Load `.texrarules` from `workspace` (the run's workspace root, when one is
 * open) or the user's home directory. Returns the trimmed content or an empty
 * string if none found.
 *
 * A missing file is the ordinary case and answers with the empty string; every
 * other filesystem failure (a permission error, an unreadable root) is warned
 * about before it does, because a silently absent rules file reads exactly
 * like a run the user never wrote rules for.
 */
export const loadTexraRules = (
  workspace: string | undefined,
): Effect.Effect<string, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    // Precedence order: the run's workspace, then the home directory. A root
    // whose file is absent or blank falls through to the next one.
    const candidates: Array<{ root: string; source: string }> = [];
    if (workspace) candidates.push({ root: workspace, source: 'workspace' });
    const homeDir = safeHomedir();
    if (homeDir) candidates.push({ root: homeDir, source: 'home' });

    for (const { root, source } of candidates) {
      const file = path.join(root, RULES_FILE);
      if (!(yield* entryExists(fs, file))) continue;
      const trimmed = (yield* readNormalizedFile(fs, file)).trim();
      if (!trimmed) continue;
      yield* Effect.logDebug(`Loaded ${source} ${RULES_FILE}`).pipe(
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
      Effect.sync(() => {
        log.warn(`Failed to load ${RULES_FILE}: ${toErrorMessage(error)}`);
        return '';
      }),
    ),
  );
