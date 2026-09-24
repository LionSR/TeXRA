// Standard library imports
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// Third-party imports
import { Effect, FileSystem } from 'effect';

// Local imports
import { relativeToRoot } from '@platform/defaults/nodeWorkspace';
import { Rejected } from '@shared/session/requestErrors';
import { toErrorMessage } from '@utils/errors/errorMessage';

/**
 * One dropped path, answered with its workspace-relative name or `null` when
 * the launcher does not take it.
 *
 * A path outside the workspace, and one that does not name a regular file,
 * are both dropped. So is one that is no longer there: a drag whose source
 * moved between the drop and this probe is the user's own race, and
 * `NotFound` is the only absence this treats as one. Every other stat failure
 * (an unreadable folder, a symlink loop) fails the whole drop instead of
 * quietly shrinking it, because a path discarded in silence looks to the user
 * like a file the launcher refused. A `file:` URL that does not decode is
 * refused the same way.
 */
const droppedWorkspaceFile = Effect.fn('droppedWorkspaceFile')(function* (
  workspacePath: string,
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
  const relative = relativeToRoot(workspacePath, dropped);
  if (relative === undefined) return null;
  const fs = yield* FileSystem.FileSystem;
  const info = yield* fs.stat(path.resolve(workspacePath, relative)).pipe(
    Effect.catchIf(
      (error) => error.reason._tag === 'NotFound',
      () => Effect.succeed(undefined),
    ),
  );
  return info?.type === 'File' ? relative : null;
});

/**
 * A launcher drop onto one field: each dropped path probed against the
 * workspace (none is taken without one), then the files that field accepts.
 * The one plan every host applies to `attachDroppedFiles`.
 */
export const attachDroppedFiles = Effect.fn('attachDroppedFiles')(function* (
  workspacePath: string | undefined,
  rawPaths: readonly string[],
  allowedExtensions: readonly string[],
) {
  const resolved =
    workspacePath === undefined
      ? rawPaths.map(() => null)
      : yield* Effect.forEach(
          rawPaths,
          (raw) => droppedWorkspaceFile(workspacePath, raw),
          { concurrency: 'unbounded' },
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
  const allowed = new Set(
    allowedExtensions.map(normalizeMainViewFileExtension),
  );
  const attached = new Set<string>();
  let rejectedCount = 0;

  for (const filePath of paths) {
    if (!filePath) {
      rejectedCount += 1;
      continue;
    }
    const extension = normalizeMainViewFileExtension(filePath);
    if (!extension || !allowed.has(extension)) {
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

export function normalizeMainViewFileExtension(filePath: string): string {
  const trimmed = filePath.trim();
  const extension = path.extname(trimmed) || trimmed;
  return extension.toLowerCase().replace(/^\./, '');
}
