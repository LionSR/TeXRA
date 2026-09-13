// Standard library imports
import * as path from 'node:path';

// Third-party imports
import { Data, Effect } from 'effect';
import { globIterate } from 'glob';

// Local imports
import { createLog } from '@logger/logUtils';
import { relativeToRoot } from '@platform/defaults/nodeWorkspace';
import { normalizeFilePath } from '@utils/core';

import { CHANNEL } from './constants';

const log = createLog(CHANNEL);

/**
 * A workspace listing that did not complete. The `glob` package rejects, and
 * a housekeeping command reports that as an error result rather than as a
 * defect, so the rejection is typed here instead of caught raw.
 */
export class GlobFailed extends Data.TaggedError('GlobFailed')<{
  readonly pattern: string;
  readonly cause: unknown;
}> {
  override get message(): string {
    return `Failed to list ${this.pattern}: ${String(this.cause)}`;
  }
}

/**
 * A copy whose destination name is already taken. `FileSystem.copy` without
 * `overwrite` silently skips an existing destination; the pack commands must
 * report it, because a skipped copy means the packed folder is missing a file
 * the user was told it contains.
 */
export class DestinationExists extends Data.TaggedError('DestinationExists')<{
  readonly destination: string;
}> {
  override get message(): string {
    return `Destination already exists: ${this.destination}`;
  }
}

/**
 * Produce an ISO-8601 timestamp stripped of separators, suitable for use in
 * a file or folder name (e.g. `20260422T003541`). Second-level granularity.
 */
export function generateTimestamp(): string {
  return new Date().toISOString().replaceAll(/[-:]/g, '').split('.')[0];
}

/**
 * Matching workspace files, as paths relative to `workspaceRoot` — the root
 * of the caller's `WorkspaceFs`, passed in rather than read from an ambient
 * store, so a listing and the deletions it feeds name the same workspace.
 */
async function* findFilesFromPatterns(
  workspaceRoot: string,
  inputDir: string,
  patterns: string[],
  extensions: string[],
): AsyncGenerator<string, void, void> {
  log.debug(
    `Finding files in ${inputDir} using patterns ${patterns} and extensions ${extensions}`,
  );

  // `resolve`, not `join`: an inputDir that is already absolute names the
  // directory it says, while a workspace-relative one is taken from the
  // workspace root. Joining an absolute path onto the root duplicated the
  // prefix and found nothing.
  const searchDirs = [path.resolve(workspaceRoot, inputDir)];
  if (!inputDir.includes('build')) {
    searchDirs.push(path.resolve(workspaceRoot, inputDir, 'build'));
  }

  for (const pattern of patterns) {
    for (const ext of extensions) {
      const isGlob = ext.includes('*');
      for (const dir of searchDirs) {
        let foundExactMatch = false;
        for await (const match of globIterate(
          path.join(dir, `${pattern}${ext}`),
          { nodir: true },
        )) {
          const relativePath = normalizeFilePath(
            relativeToRoot(workspaceRoot, match) ?? match,
          );
          log.debug(`Found file: ${relativePath}`);
          yield relativePath;

          if (!isGlob) {
            foundExactMatch = true;
            break;
          }
        }

        if (foundExactMatch) {
          // Exact extensions prefer the input directory; `build/` is only the
          // fallback when the corresponding root-level artifact is absent.
          break;
        }
      }
    }
  }
}

/**
 * The workspace-relative files matching `patterns` × `extensions` under
 * `inputDir`, deduplicated — overlapping patterns match the same path more
 * than once.
 */
export const collectFilesFromPatterns = Effect.fn(
  'housekeeping.collectFilesFromPatterns',
)(function* (
  workspaceRoot: string,
  inputDir: string,
  patterns: string[],
  extensions: string[],
) {
  return yield* Effect.tryPromise({
    try: async () => {
      const files = new Set<string>();
      for await (const file of findFilesFromPatterns(
        workspaceRoot,
        inputDir,
        patterns,
        extensions,
      )) {
        files.add(file);
      }
      return files;
    },
    catch: (cause) =>
      new GlobFailed({ pattern: `${inputDir}: ${patterns.join(', ')}`, cause }),
  });
});
