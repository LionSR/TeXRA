/**
 * One process-wide exclusive lane per file, for a read-modify-write of it: an
 * edit reads the file, changes the text and writes it whole, with I/O (for an
 * approved edit, minutes of waiting) in between, while parallel runs edit the
 * same files. Keyed by resolved absolute path so every writer of one file meets
 * on one lane whatever view it wrote through; `withPerKeyLane` deletes a lane
 * once idle.
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
