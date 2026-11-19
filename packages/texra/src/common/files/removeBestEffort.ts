// Third-party imports
import { Effect, type FileSystem } from 'effect';

/**
 * Remove each of `paths` from `fs`, eight at a time, as a best-effort sweep:
 * a path already gone counts as removed (`force`), and a failure is logged
 * at warn without stopping the rest. Answers the paths it removed, so a
 * caller can name the ones it did not. `what` names a path in the log
 * (`backup file`, `build directory`); `recursive` removes a directory with
 * its contents. The caller sets the log channel.
 */
export const removeBestEffort = Effect.fn('removeBestEffort')(function* (
  fs: FileSystem.FileSystem,
  paths: readonly string[],
  what: string,
  options: { readonly recursive?: boolean } = {},
) {
  const removed = yield* Effect.forEach(
    paths,
    (target) =>
      fs.remove(target, { force: true, recursive: options.recursive }).pipe(
        Effect.andThen(Effect.logDebug(`Removed ${what} ${target}`)),
        Effect.as(true),
        Effect.catch((error) =>
          Effect.logWarning(
            `Could not remove ${what} ${target}: ${error.message}`,
          ).pipe(Effect.as(false)),
        ),
      ),
    { concurrency: 8 },
  );
  return paths.filter((_, index) => removed[index]);
});
