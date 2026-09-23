// Third-party imports
import { Effect } from 'effect';

// Local imports - utilities
import escapeRegExp from 'escape-string-regexp';

/**
 * Scan candidate files for `\label{<label>}` and hand the first match to
 * `onMatch(file, index)`, where `index` is the character offset of the match
 * (so editors can reveal the label position).
 *
 * Reading a candidate and handling its match are both part of the scan: a
 * `read` or `onMatch` that fails is logged, skips that candidate, and scanning continues,
 * so a transient read/open failure on one match falls through to another file
 * that contains the same label. Answers `true` once a match has been handled,
 * `false` if no candidate matched (or every matching candidate failed to
 * handle) — the caller owns the "no file defines this label" report.
 *
 * Host-neutral: callers supply their own file lister, reader, and open
 * handler, so the VS Code command and the desktop bridge share one scan.
 */
export function openFirstLabelMatch<ReadError, MatchError>(
  label: string,
  files: Iterable<string>,
  read: (file: string) => Effect.Effect<string, ReadError>,
  onMatch: (file: string, index: number) => Effect.Effect<unknown, MatchError>,
): Effect.Effect<boolean> {
  // A regex matching `\label{<label>}` for a literal label string.
  const pattern = new RegExp(`\\\\label\\{${escapeRegExp(label)}\\}`, 'm');
  return Effect.gen(function* () {
    for (const file of files) {
      const handled = yield* read(file).pipe(
        Effect.flatMap((content) => {
          const match = content.match(pattern);
          if (!match || match.index === undefined) return Effect.succeed(false);
          return Effect.as(onMatch(file, match.index), true);
        }),
        Effect.catch((error) =>
          Effect.logWarning(`Skipping ${file} in the label search`, error).pipe(
            Effect.as(false),
          ),
        ),
      );
      if (handled) return true;
    }
    return false;
  });
}
