/**
 * The one write of a project file a window makes on a person's word (the
 * editor's save, the accept of a task's output): the file ends up holding
 * `contents`, provided it was as the person last saw it. It runs in the
 * process that holds the project's session, where the project's tasks
 * write, because the file's write lane (`withFileWriteLane`) is one per
 * process: a window whose project the background service holds asks the
 * service for it (`file.write`), and every other window runs it itself
 * (`GuiSession.writeFile` is decided once, at open). Which path a surface may
 * name is the caller's rule, decided before this is reached; a path here is
 * absolute.
 */
import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { Effect, FileSystem, Schema } from 'effect';

import { withFileWriteLane } from '@texra-ai/harness/plugins';
import { meansAbsent, readNormalizedFile } from '@texra-ai/harness/node';
import { Rejected } from '@texra-ai/harness/schemas';

/** What the file must be for the write to land: anything, not there, or
 *  holding `contents` as the editor reads a file (`readNormalizedFile`). A
 *  file that held `contents` and is gone is written again. */
export const ExpectedFileSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('anything') }),
  Schema.Struct({ kind: Schema.Literal('absent') }),
  Schema.Struct({ kind: Schema.Literal('holds'), contents: Schema.String }),
]);
type ExpectedFile = typeof ExpectedFileSchema.Type;

/** Make the file at `path` hold `contents` while it is as `expected`;
 *  answers whether it holds them now. A filesystem failure is `Rejected`, in
 *  its own words. */
export type WriteProjectFile = (
  path: string,
  contents: string,
  expected: ExpectedFile,
) => Effect.Effect<boolean, Rejected, FileSystem.FileSystem>;

/**
 * {@link WriteProjectFile} in this process. Both checks read the file as the
 * editor does, so its line endings never count as a change. A file that
 * already holds `contents` is the write done, whatever was expected: so a write repeated
 * after its answer was lost (the service wrote it, the reply never came)
 * reads as the success it was, never as someone else's change. The check
 * and the write hold the file's write lane, which an approved edit of a
 * task here holds too, so neither lands between the other's check and
 * write. The new content is staged beside the file and renamed over it, so
 * a write that fails partway leaves the file as it was; an existing file is
 * replaced where a symlink points, with the mode it had.
 */
export const writeFileIfUnchanged: WriteProjectFile = Effect.fn(
  'writeFileIfUnchanged',
)(
  function* (target, contents, expected) {
    const fs = yield* FileSystem.FileSystem;
    return yield* Effect.gen(function* () {
      // As the editor reads it: line endings as LF, a leading BOM kept.
      const onDisk = yield* readNormalizedFile(fs, target).pipe(
        Effect.catchIf(meansAbsent, () => Effect.succeed(null)),
      );
      if (onDisk === contents) return true;
      if (
        onDisk !== null &&
        (expected.kind === 'absent' ||
          (expected.kind === 'holds' && onDisk !== expected.contents))
      )
        return false;
      const real = onDisk === null ? target : yield* fs.realPath(target);
      const mode =
        onDisk === null ? undefined : (yield* fs.stat(real)).mode & 0o7777;
      const staged = path.join(
        path.dirname(real),
        `.${path.basename(real)}.${randomUUID()}.tmp`,
      );
      yield* fs.writeFileString(staged, contents).pipe(
        Effect.andThen(
          mode === undefined ? Effect.void : fs.chmod(staged, mode),
        ),
        Effect.andThen(fs.rename(staged, real)),
        Effect.onError(() =>
          fs.remove(staged, { force: true }).pipe(
            Effect.ignore({
              log: 'Warn',
              message: `A staged project file stays behind: ${staged}`,
            }),
          ),
        ),
        Effect.uninterruptible,
      );
      return true;
    }).pipe(withFileWriteLane(target));
  },
  Effect.catchTag('PlatformError', (error) =>
    Effect.fail(new Rejected({ reason: error.message })),
  ),
);
