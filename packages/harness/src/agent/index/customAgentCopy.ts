/**
 * Customized copies of bundled agents. A copy lands in the custom agents
 * directory stamped with `basedOn`, the digest of the bundled file it was taken
 * from, so the catalog can tell when an app update ships a newer bundled
 * version (`changedBuiltInOf`). Every host's "customize" and "keep mine" write
 * through here.
 */
import * as path from 'node:path';

import { Effect, FileSystem } from 'effect';

import { agentKey } from '@shared/schemas';
import { isStrictlyWithin } from '@utils/core/pathCore';

import { changedBuiltInOf, getAgent } from './agentRegistry';

/**
 * Where the copy of the bundled definition at `entryPath` lands: the same
 * path, relative to the source root that holds it (`agentSourceRoots`),
 * under `customDir`, or undefined when that escapes it.
 */
export function customCopyPath(input: {
  readonly entryPath: string;
  readonly sourceRoots: readonly string[];
  readonly customDir: string;
}): string | undefined {
  const { entryPath, customDir } = input;
  const sourceRoot = input.sourceRoots.find((root) =>
    isStrictlyWithin(root, entryPath),
  );
  const targetPath = path.join(
    customDir,
    sourceRoot
      ? path.relative(sourceRoot, entryPath)
      : path.basename(entryPath),
  );
  return isStrictlyWithin(customDir, targetPath) ? targetPath : undefined;
}

/**
 * Write the definition at `from` to `to`, recording `digest` as the bundled
 * version it is based on: a fresh copy stamps the bundled file's digest, and
 * "keep mine" re-stamps the user's own file with the newer one. `basedOn` is a
 * top-level key, so any earlier stamp line is replaced rather than repeated.
 */
export const writeStampedCopy = Effect.fn('writeStampedCopy')(function* (
  from: string,
  to: string,
  digest: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const text = (yield* fs.readFileString(from)).replace(/^basedOn:.*\n?/m, '');
  yield* fs.makeDirectory(path.dirname(to), { recursive: true });
  yield* fs.writeFileString(
    to,
    `${text.endsWith('\n') ? text : `${text}\n`}basedOn: ${digest} # the bundled version this copy started from\n`,
  );
});

/**
 * "Keep mine": record the changed bundled version as the one the custom copy
 * named `name` is now based on, which clears its newer-version notice without
 * touching anything else in the file. False when there is nothing to dismiss.
 */
export const keepCustomAgent = Effect.fn('keepCustomAgent')(function* (
  name: string,
) {
  const custom = getAgent(agentKey('custom', name));
  const builtIn = custom && changedBuiltInOf(custom);
  if (!custom || builtIn?.digest == null) return false;
  yield* writeStampedCopy(custom.path, custom.path, builtIn.digest);
  return true;
});
