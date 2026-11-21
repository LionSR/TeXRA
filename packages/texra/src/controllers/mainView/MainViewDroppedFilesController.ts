// Standard library imports
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// Third-party imports
import { Effect, FileSystem } from 'effect';

// Local imports
import { meansAbsent, relativeToRoot } from '@texra-ai/harness/node';
import { toErrorMessage, Rejected } from '@texra-ai/harness/schemas';

/**
 * One dropped path, answered with its workspace-relative name or `null` when
 * the launcher does not take it.
 *
 * A path outside the workspace, and one that does not name a regular file,
 * are both dropped. So is one that is no longer there: a drag whose source
 * moved between the drop and this probe is the user's own race, and
 * `meansAbsent`'s absence (nothing at the path, or a parent component that
 * is now a file) is the only failure this treats as one. Every other stat
 * failure (an unreadable folder, a symlink loop) fails the whole drop
 * instead of quietly shrinking it, because a path discarded in silence looks
 * to the user like a file the launcher refused. A `file:` URL that does not
 * decode is refused the same way.
 */
const droppedWorkspaceFile = Effect.fn('droppedWorkspaceFile')(function* (
  workspaceRoot: string,
  raw: string,
) {
  const trimmed = raw.trim();
  const dropped = trimmed.startsWith('file:')
    ? yield* Effect.try({
        try: () => fileURLToPath(trimmed),
        catch: (cause) =>
          new Rejected({
            reason: `Dropped path is not a file URL: ${trimmed}: ${toErrorMessage(cause)}`,
          }),
      })
    : trimmed;
  const relative = relativeToRoot(workspaceRoot, dropped);
  if (relative === undefined) return null;
  const fs = yield* FileSystem.FileSystem;
  const info = yield* fs
    .stat(path.resolve(workspaceRoot, relative))
    .pipe(Effect.catchIf(meansAbsent, () => Effect.undefined));
  return info?.type === 'File' ? relative : null;
});

/**
 * A launcher drop onto one field: each dropped path probed against the
 * workspace (none is taken without one), then the files that field accepts.
 * The one plan every host applies to `attachDroppedFiles`.
 */
export const attachDroppedFiles = Effect.fn('attachDroppedFiles')(function* (
  workspaceRoot: string | undefined,
  rawPaths: readonly string[],
  allowedExtensions: readonly string[],
) {
  const resolved =
    workspaceRoot === undefined
      ? rawPaths.map(() => null)
      : yield* Effect.forEach(
          rawPaths,
          (raw) => droppedWorkspaceFile(workspaceRoot, raw),
          { concurrency: 8 },
        );
  return yield* attachDroppedPaths(resolved, allowedExtensions);
});

/**
 * The dropped paths one launcher field takes: every non-null path whose
 * extension that field accepts, deduplicated and in drop order. A drop that
 * attached nothing but rejected something is the user's to hear about, so it
 * is a rejection rather than an empty result.
 */
function attachDroppedPaths(
  paths: readonly (string | null)[],
  allowedExtensions: readonly string[],
): Effect.Effect<
  { paths: string[]; attachedCount: number; rejectedCount: number },
  Rejected
> {
  const takes = fieldTakes(allowedExtensions);
  const attached = new Set<string>();
  let rejectedCount = 0;

  for (const filePath of paths) {
    if (!filePath || !takes(filePath)) {
      rejectedCount += 1;
      continue;
    }
    attached.add(filePath);
  }

  if (attached.size === 0 && rejectedCount > 0) {
    return Effect.fail(
      new Rejected({
        reason:
          'No dropped files were attached. Use regular files inside this workspace with supported TeXRA extensions.',
      }),
    );
  }

  return Effect.succeed({
    paths: [...attached],
    attachedCount: attached.size,
    rejectedCount,
  });
}

/** A file's extension as the launcher compares it: lower case, no dot. */
function extensionOf(filePath: string): string {
  const trimmed = filePath.trim();
  const extension = path.extname(trimmed) || trimmed;
  return extension.toLowerCase().replace(/^\./, '');
}

/**
 * Whether a launcher field whose files have `allowedExtensions` takes a
 * file, by its extension: the one test a drop and the editor's open files
 * apply.
 */
export function fieldTakes(
  allowedExtensions: readonly string[],
): (filePath: string) => boolean {
  const allowed = new Set(allowedExtensions.map(extensionOf));
  return (filePath) => {
    const extension = extensionOf(filePath);
    return extension !== '' && allowed.has(extension);
  };
}
