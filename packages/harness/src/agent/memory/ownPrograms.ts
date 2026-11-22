/**
 * The programs an agent wrote for itself: each `programs/<name>.js` of a
 * project's memory folder is the program `own:<name>`, from the step after
 * the file is written and in every later conversation of the project.
 *
 * The memory folder is the one place only the agent and its user write: it
 * is stored beside the project's runs, not in the repository, so a cloned
 * project carries none. Nobody reviews such a file and nothing records a
 * trust in it, because it can do nothing its writer could not: it is
 * evaluated only in the script sandbox, its run is offered only the tools
 * its `uses` names, through the user's switches and approval policy, and the
 * agents and programs it starts are asked about as a model's script's are
 * (`programOrigin`).
 */

// Node imports
import * as path from 'node:path';

// Third-party imports
import type { Effect, FileSystem } from 'effect';

// Local imports
import {
  readPrograms,
  type PluginPrograms,
} from '@common/plugins/pluginPrograms';
import { WORKSPACE_STORAGE_LAYOUT } from '@common/storage/storageLayout';
import { OWN_PROGRAM_PREFIX } from '@shared/schemas';

/** The directory of a project's memory folder that holds them. */
export const OWN_PROGRAMS_DIRECTORY = 'programs';

/**
 * How many of them a step lists to its model. The list is sent with every
 * request, and one line is a name and up to 300 characters, so 20 lines
 * stay under two thousand tokens however many files the directory holds.
 * The others are started by name all the same.
 */
export const OWN_PROGRAMS_LISTED = 20;

/** The agent's own programs in the project stored at `storage`, read as an
 *  installed plugin's are: as text, never run, a malformed file refused by
 *  name. */
export const readOwnPrograms = (
  storage: string,
): Effect.Effect<PluginPrograms, never, FileSystem.FileSystem> => {
  const root = path.join(
    storage,
    WORKSPACE_STORAGE_LAYOUT.memory,
    OWN_PROGRAMS_DIRECTORY,
  );
  return readPrograms({
    root,
    prefix: OWN_PROGRAM_PREFIX,
    named: (entry) => path.join(root, entry),
  });
};
