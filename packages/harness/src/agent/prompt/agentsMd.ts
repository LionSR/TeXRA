import * as path from 'node:path';

// Third-party imports
import { Effect, FileSystem } from 'effect';

import { PromptRenderFailed } from '@agent/prompt/promptRender';
import { withLogChannel } from '@logger/effectLog';
import { toErrorMessage } from '@utils/errors/errorMessage';

import { readNormalizedFile } from '@utils/files/fsDurability';
import { meansAbsent, entryExists } from '@utils/files/fsEntryExists';

const CHANNEL = 'agentsMd';

const AGENTS_FILE = 'AGENTS.md';

/**
 * Load the instructions every agent follows: the person's own `AGENTS.md`
 * at `storageRoot`, the storage root the host opened (TeXRA's `~/.texra`),
 * where their skills and `mcp.json` are found too, and the project's at
 * `workspace` (the run's workspace root, when one is open). Both apply: the
 * person's come first and the project's last, each under a line that says
 * whose it is, so the more specific one reads as the later word. One file
 * alone is returned as it is. `AGENTS.md` is the one instructions file; no
 * other name is read. Returns an empty string if neither is there.
 *
 * A missing or blank file is the ordinary case and contributes nothing;
 * every other filesystem failure (a permission error, an unreadable root)
 * fails the load with the file's path, because a silently absent
 * instructions file reads exactly like a run the user never wrote
 * instructions for.
 */
export const loadAgentsMd = Effect.fn('agentsMd.loadAgentsMd')(function* (
  workspace: string | undefined,
  storageRoot: string,
): Effect.fn.Return<string, PromptRenderFailed, FileSystem.FileSystem> {
  const fs = yield* FileSystem.FileSystem;
  const read = Effect.fn(function* (root: string, source: string) {
    const file = path.join(root, AGENTS_FILE);
    // Absent, a dangling link included, is ''.
    const content = yield* Effect.gen(function* () {
      if (!(yield* entryExists(fs, file))) return '';
      return yield* readNormalizedFile(fs, file);
    }).pipe(
      Effect.catchIf(meansAbsent, () => Effect.succeed('')),
      Effect.mapError(
        (error) =>
          new PromptRenderFailed({
            message: `Failed to load ${file}: ${toErrorMessage(error)}`,
            cause: error,
          }),
      ),
    );
    const trimmed = content.trim();
    if (trimmed)
      yield* Effect.logDebug(`Loaded ${source} ${AGENTS_FILE}`).pipe(
        withLogChannel(CHANNEL),
      );
    return trimmed;
  });
  const [own, project] = yield* Effect.all(
    [
      read(storageRoot, 'user'),
      // A workspace that is the storage root itself has one file, not two.
      workspace && path.resolve(workspace) !== path.resolve(storageRoot)
        ? read(workspace, 'workspace')
        : Effect.succeed(''),
    ],
    { concurrency: 'unbounded' },
  );
  if (!own || !project) return own || project;
  return `The person's own instructions, for every project:\n${own}\n\nThis project's instructions, which come first where the two disagree:\n${project}`;
});
