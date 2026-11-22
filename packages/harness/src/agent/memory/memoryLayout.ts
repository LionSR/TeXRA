/**
 * An agent's memory: two folders of Markdown notes that outlast a
 * conversation, one the person's own across every project and one the
 * project's. They are ordinary files. A run reads and writes them with its
 * file tools (each folder is a root its steps accept), and the only thing
 * the harness does with them is show each folder's index, `MEMORY.md`, in
 * the system text of every step, so what was written reaches the next
 * request and the next conversation without a tool call.
 */

// Node imports
import * as path from 'node:path';

// Third-party imports
import { Effect, FileSystem } from 'effect';

// Local imports
import { WORKSPACE_STORAGE_LAYOUT } from '@common/storage/storageLayout';
import { withLogChannel } from '@logger/effectLog';
import type { WorkspaceRoots } from '@platform/workspaceRoots';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { canonicalizePath, type StepRoot } from '@utils/files/externalRoots';
import { readNormalizedFile } from '@utils/files/fsDurability';
import { meansAbsent } from '@utils/files/fsEntryExists';

/** The file of a memory folder a step shows its model. */
export const MEMORY_INDEX = 'MEMORY.md';

/**
 * How much of one index a step shows. The text is sent with every request,
 * so it is bounded however long the file grows: about four thousand tokens,
 * cut at a line.
 */
const MEMORY_INDEX_MAX_CHARS = 16_000;

/** One memory folder: where it is, and what belongs in it. */
export interface MemoryFolder {
  readonly path: string;
  readonly label: string;
  readonly holds: string;
}

/**
 * The memory folders of the project stored at `roots`: the person's, under
 * the storage root beside their `AGENTS.md` and skills, and the project's,
 * beside its runs. Neither is in the repository, so a cloned project brings
 * none.
 */
export const memoryFolders = (
  roots: Pick<WorkspaceRoots, 'storage' | 'storageRoot'>,
): readonly MemoryFolder[] => [
  {
    path: path.join(roots.storageRoot, WORKSPACE_STORAGE_LAYOUT.memory),
    label: 'Your memory',
    holds: 'what is true of the person in every project',
  },
  {
    path: path.join(roots.storage, WORKSPACE_STORAGE_LAYOUT.memory),
    label: 'Project memory',
    holds: 'what is true of this project',
  },
];

/** The roots a step accepts for `folders`, which its calls read and write. */
export const memoryRoots = (
  folders: readonly MemoryFolder[],
): readonly StepRoot[] =>
  folders.map(({ path: folder, label }) => ({
    absolutePath: canonicalizePath(folder),
    label,
    writable: true,
  }));

/** `text` cut to the bound at a line, saying so where it was cut. */
const bounded = (text: string): string => {
  if (text.length <= MEMORY_INDEX_MAX_CHARS) return text;
  const cut = text.lastIndexOf('\n', MEMORY_INDEX_MAX_CHARS);
  return `${text.slice(0, cut > 0 ? cut : MEMORY_INDEX_MAX_CHARS)}\n(the rest of this index is not shown: shorten it)`;
};

/**
 * The memory section of a step's system text: how to use the folders, and
 * each index as it reads now. It names a folder by its label and never by
 * its path, which the run's opening states once with its workspace: the
 * section is built again at every step, and a path in it would read as a
 * change to a run resumed with its storage somewhere else. A folder with no
 * index says so. An index that is there and cannot be read is named with
 * its error, and logged, because a section that silently dropped it would
 * read as a folder the agent never wrote to.
 */
export const memorySection = Effect.fn('memory.section')(function* (
  folders: readonly MemoryFolder[],
): Effect.fn.Return<string, never, FileSystem.FileSystem> {
  const fs = yield* FileSystem.FileSystem;
  const indexes = yield* Effect.forEach(
    folders,
    ({ path: folder, label }) => {
      const file = path.join(folder, MEMORY_INDEX);
      return readNormalizedFile(fs, file).pipe(
        Effect.map((text) => bounded(text.trim())),
        Effect.catchIf(meansAbsent, () => Effect.succeed('')),
        Effect.catch((error) =>
          Effect.as(
            Effect.logWarning(
              `Cannot read ${file}: ${toErrorMessage(error)}`,
            ).pipe(withLogChannel('memory')),
            `(this index could not be read: ${toErrorMessage(error)})`,
          ),
        ),
        Effect.map(
          (text) =>
            `<memory_index folder="${label}">\n${
              text === '' ? `(no ${MEMORY_INDEX} yet)` : text
            }\n</memory_index>`,
        ),
      );
    },
    { concurrency: 'unbounded' },
  );
  return `<memory>
You have ${folders.length} folders of Markdown notes that persist across conversations: ${folders.map(({ label, holds }) => `"${label}", for ${holds}`).join('; ')}. Their paths are listed with the accessible directories in <workspace_info>. They are ordinary files: read and write them with your file tools, by absolute path. Each folder's ${MEMORY_INDEX} is its index, shown below as it reads now, one line per note; the notes themselves are not shown, so read one when its line looks relevant to the request.
When you learn something a later conversation will need (a preference, a decision, a convention, a pitfall), write it to a note in the folder it belongs to and keep that folder's ${MEMORY_INDEX} current. Update or remove a note that is no longer true rather than adding a second one. Do not store what the project's own files already state, and do not write anything when there is nothing worth keeping.
${indexes.join('\n')}
</memory>`;
});
