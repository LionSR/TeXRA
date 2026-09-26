/**
 * One process-wide exclusive lane per file, for a read-modify-write of it.
 *
 * A tool that edits a file reads it, changes the text and writes it whole,
 * with I/O (and, for an approved edit, a wait of minutes) in between, while
 * parallel runs (an orchestrator's subagents, other sessions) edit the same
 * files. Two such edits without a lane both read one version and the later
 * write drops the other's change. Keyed by resolved absolute path, so every
 * writer of one file meets on one lane whatever view it wrote through;
 * `withPerKeyLane` deletes a lane once idle.
 */
import * as nodePath from 'node:path';

import { type PerKeyLane, withPerKeyLane } from '@utils/core/perKeyQueue';
import type { Effect } from 'effect';

const fileLanes = new Map<string, PerKeyLane>();

export function onFileLane(
  absolutePath: string,
): <A, E, R>(self: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R> {
  return withPerKeyLane(fileLanes, nodePath.resolve(absolutePath));
}
