// Node imports
import * as nodePath from 'node:path';

// Third-party imports
import { Effect, FileSystem, Option } from 'effect';
import { Glob } from 'glob';
import { z } from 'zod';
import { ToolCall } from '@agent/runtime/ToolCall';

// Local imports
import { ToolError, ToolResult } from '@shared/schemas';
import { getGitignoreMatcher } from '@tools/gitignore';
import { formatToolOutput } from '@tools/formatting';
import { resolveToolPath, type ToolPathCall } from '@tools/pathResolution';
import { executed } from '@tools/core/result';
import { filterNotNull } from '@utils/core';
import { toPosixPath } from '@utils/core/pathCore';
import { globEscape } from '@utils/files/rootedFileSystem';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { pluralize } from '@utils/text/stringUtils';

// Local file imports
import { defineTool } from './core/define';

const GlobInputSchema = z.strictObject({
  pattern: z
    .string()
    .min(1, 'pattern is required')
    .describe('Glob pattern to match, such as "**/*.tex" or "src/**/*.ts".'),
  path: z
    .string()
    .nullish()
    .describe('Directory to search within. Defaults to the workspace root.'),
});

type GlobInput = z.infer<typeof GlobInputSchema>;

interface GlobMatchInfo {
  relativePath: string;
  mtime: number;
}

/**
 * The per-call context this tool reads from the caller's turn: the batch's
 * abort signal and the working directory.
 */
interface GlobPorts {
  readonly call: ToolPathCall;
  readonly signal: AbortSignal | undefined;
}

const runGlob = Effect.fn('GlobTool.execute')(function* (
  ports: GlobPorts,
  input: GlobInput,
): Effect.fn.Return<ToolResult, Error, FileSystem.FileSystem> {
  const { call } = ports;
  const path = yield* resolveToolPath(call, input.path ?? undefined);
  const { display } = path;
  const gitignore = yield* getGitignoreMatcher(call.roots.workspace);

  const cancelSignal = ports.signal;
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
        // Large-tree walks stop promptly when the batch is aborted.
        signal: cancelSignal,
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

  // The walk is done, but stat-ing every match on a large tree is itself
  // slow — bail before it so a cancelled batch doesn't wait out the
  // post-walk stat/sort phase across several concurrent glob calls.
  if (cancelSignal?.aborted) {
    return yield* Effect.fail(
      new ToolError('Cancelled before stat-ing glob matches.'),
    );
  }

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
    .filter(filterNotNull)
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
  parallelSafe: true,
  description:
    'Find files matching glob patterns (e.g., "**/*.tex", "src/**/*.ts"). Returns paths sorted by modification time.',
  schema: GlobInputSchema,
  execute: Effect.fn('GlobTool.call')(function* (input: GlobInput) {
    const call = yield* ToolCall;
    const ports: GlobPorts = {
      call,
      signal: yield* Effect.abortSignal,
    };
    return yield* runGlob(ports, input);
  }),
});
