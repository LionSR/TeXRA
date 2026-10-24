// Node imports
import * as nodePath from 'node:path';

// Third-party imports
import {
  Effect,
  FileSystem,
  Option,
  Predicate,
  Schema,
  type Scope,
} from 'effect';
import { Glob } from 'glob';
import { ToolContext } from '@agent/core/tools/ToolTypes';

// Local imports
import { ToolError, ToolResult } from '@shared/schemas';
import { resolveToolPath } from '@tools/pathResolution';
import { getGitignoreMatcher } from '@tools/gitignore';
import { formatToolOutput } from '@tools/formatting';
import { executed } from '@tools/core/result';
import { toPosixPath } from '@utils/core/pathCore';
import { globEscape } from '@utils/files/rootedFileSystem';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { pluralize } from '@utils/text/stringUtils';

// Local file imports
import { defineTool } from './core/definition';

const GlobInputSchema = Schema.Struct({
  pattern: Schema.String.check(Schema.isMinLength(1)).annotate({
    description: 'Glob pattern to match, such as "**/*.tex" or "src/**/*.ts".',
  }),
  path: Schema.optional(Schema.NullOr(Schema.String)).annotate({
    description: 'Directory to search within. Defaults to the workspace root.',
  }),
});

type GlobInput = typeof GlobInputSchema.Type;

interface GlobMatchInfo {
  relativePath: string;
  mtime: number;
}

const runGlob = Effect.fn('GlobTool.execute')(function* (
  input: GlobInput,
): Effect.fn.Return<
  ToolResult,
  Error,
  ToolContext | Scope.Scope | FileSystem.FileSystem
> {
  const call = (yield* ToolContext).env;
  // Aborted when the call's scope closes: an interrupted call stops the walk
  // it abandons.
  const signal = yield* Effect.abortSignal;
  const path = yield* resolveToolPath(call, input.path ?? undefined);
  const { display } = path;
  const gitignore = yield* getGitignoreMatcher(call.roots.workspace);

  const patternError = (err: unknown) =>
    new ToolError(
      `Glob pattern error: ${toErrorMessage(err)}. ` +
        `Check syntax: use ** for recursive, * for single level. Example: "**/*.tex"`,
    );
  const walker = yield* Effect.try({
    try: () =>
      new Glob(input.pattern, {
        cwd: path.absolute,
        dot: true,
        nodir: false,
        absolute: false,
        signal,
        follow: false,
      }),
    catch: patternError,
  });
  // Refused before the walk: an absolute or `..` alternative would walk
  // outside the search directory (the whole disk, for `/**`).
  const escaping = globEscape(walker.patterns);
  if (escaping !== undefined) {
    return yield* Effect.fail(
      new ToolError(
        `Glob pattern must stay under the search directory: "${escaping}". ` +
          `Put an outside base in "path" instead (for example path ".." with pattern "**/*.tex"); that path is still checked against the allowed roots.`,
      ),
    );
  }
  const matches = yield* Effect.tryPromise({
    try: () => walker.walk(),
    catch: patternError,
  });

  const fs = yield* FileSystem.FileSystem;
  const statMatch = Effect.fn('GlobTool.statMatch')(function* (
    match: string,
  ): Effect.fn.Return<GlobMatchInfo | null, Error> {
    const resolved = yield* resolveToolPath(
      call,
      // posix.join, not path.join: the base and the match are both
      // POSIX-normalized, and path.join would reintroduce backslashes
      // on Windows. `|| '.'` keeps an empty base a relative join.
      nodePath.posix.join(path.relative || '.', match),
    ).pipe(
      Effect.mapError(
        (err) =>
          new ToolError(
            `Match resolved outside the working directory: ${match} (${toErrorMessage(err)})`,
          ),
      ),
    );

    const relativePath = resolved.relative;
    if (
      relativePath === '.' ||
      (!nodePath.isAbsolute(relativePath) && gitignore.ignores(relativePath))
    ) {
      return null;
    }

    // The match was resolved inside the call's workspace frame, so its
    // absolute form is what the process filesystem stats — a match under a
    // registered external root included, as through the workspace facade.
    return yield* fs.stat(resolved.absolute).pipe(
      Effect.map((stat): GlobMatchInfo | null => ({
        relativePath,
        mtime: Option.match(stat.mtime, {
          onNone: () => 0,
          onSome: (modified) => modified.getTime(),
        }),
      })),
      // A match that vanished, or whose path stopped naming something a stat
      // can follow, between the walk and the stat is dropped; any other stat
      // failure is real.
      Effect.catchIf(
        (error) =>
          error.reason._tag === 'NotFound' ||
          error.reason._tag === 'BadResource',
        () => Effect.succeed(null),
      ),
    );
  });

  // Process matches in parallel for better performance
  const results = yield* Effect.forEach(matches, statMatch, {
    concurrency: 'unbounded',
  });
  const lines = results
    .filter(Predicate.isNotNull)
    .toSorted((a, b) => {
      if (b.mtime !== a.mtime) {
        return b.mtime - a.mtime;
      }
      return a.relativePath.localeCompare(b.relativePath);
    })
    .map((item) => toPosixPath(item.relativePath));
  const count = lines.length;
  const header = `Found ${count} ${pluralize(count, 'file')} matching "${input.pattern}" under ${display}`;
  return executed(
    formatToolOutput(header, lines, '(no matches)'),
    `Found ${count} ${pluralize(count, 'file')} for "${input.pattern}" in ${display}`,
  );
});

export const GlobTool = defineTool({
  name: 'glob',
  replay: 'safe',
  lane: 'parallel',
  description:
    'Find files matching glob patterns (e.g., "**/*.tex", "src/**/*.ts"). Returns paths sorted by modification time.',
  schema: GlobInputSchema,
  execute: runGlob,
});
