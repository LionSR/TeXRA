/**
 * Customized copies of bundled agents. A copy lands in the custom agents
 * directory stamped with `basedOn`, the digest of the bundled file it was taken
 * from, so the catalog can tell when an app update ships a newer bundled
 * version (`changedBuiltInOf`). Every host's "customize" and "keep mine" write
 * through here.
 */
import * as path from 'node:path';

import { Effect, FileSystem } from 'effect';

import { agentKey, type AgentSource } from '@shared/schemas';
import { isStrictlyWithin } from '@utils/core/pathCore';

import { changedBuiltInOf, getAgent } from './agentRegistry';
import { builtInToolUseRoots } from './BundledAgentDirectories';

/**
 * Where the copy of the bundled definition at `entryPath` lands: the same
 * relative path under `customDir`, or undefined when that escapes it. A tool
 * plugin's bundled tool-use agent sits in its own root, not under the core
 * source directory, so it is relativized against the root that holds it.
 */
export function customCopyPath(input: {
  readonly entryPath: string;
  readonly source: AgentSource;
  readonly sourceDir: string | undefined;
  readonly customDir: string;
}): string | undefined {
  const { entryPath, sourceDir, customDir } = input;
  const sourceRoot =
    sourceDir && input.source === 'builtInToolUse'
      ? (builtInToolUseRoots(sourceDir).find((root) =>
          isStrictlyWithin(root, entryPath),
        ) ?? sourceDir)
      : sourceDir;
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
