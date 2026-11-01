// Third-party imports
import { Effect, Option, Result } from 'effect';

// Local imports - utilities
import escapeRegExp from 'escape-string-regexp';

/**
 * Scan candidate files for `\label{<label>}` and hand the first match to
 * `onMatch(file, index)`, where `index` is the character offset of the match
 * in the file's text with CRLF line endings read as LF (so editors can reveal
 * the label position).
 *
 * A candidate that cannot be read is logged and skipped, and so is a match
 * `onMatch` fails to handle, so a transient failure on one file falls through
 * to another that defines the same label. Answers `true` once a match has
 * been handled and `false` when no candidate defines the label; the caller
 * owns that "no file defines this label" report. When the label was found but
 * no match could be handled, the last handling failure is the answer: a label
 * that exists is never reported missing.
 */
export function openFirstLabelMatch<ReadError, MatchError>(
  label: string,
  files: Iterable<string>,
  read: (file: string) => Effect.Effect<string, ReadError>,
  onMatch: (file: string, index: number) => Effect.Effect<unknown, MatchError>,
): Effect.Effect<boolean, MatchError> {
  // A regex matching `\label{<label>}` for a literal label string.
  const pattern = new RegExp(`\\\\label\\{${escapeRegExp(label)}\\}`, 'm');
  return Effect.gen(function* () {
    let unhandled: Option.Option<MatchError> = Option.none();
    for (const file of files) {
      const content = yield* Effect.result(read(file));
      if (Result.isFailure(content)) {
        yield* Effect.logWarning(
          `Skipping ${file} in the label search`,
          content.failure,
        );
        continue;
      }
      const match = content.success.replaceAll('\r\n', '\n').match(pattern);
      if (!match || match.index === undefined) continue;
      const opened = yield* Effect.result(onMatch(file, match.index));
      if (Result.isSuccess(opened)) return true;
      yield* Effect.logWarning(
        `The match for ${label} in ${file} could not be opened`,
        opened.failure,
      );
      unhandled = Option.some(opened.failure);
    }
    if (Option.isSome(unhandled)) return yield* Effect.fail(unhandled.value);
    return false;
  });
}
