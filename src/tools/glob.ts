// Node imports
import { AsyncLocalStorage } from 'node:async_hooks';
import * as nodePath from 'node:path';

// Third-party imports
import { Effect } from 'effect';
import { glob } from 'glob';
import { z } from 'zod';

// Local imports
import { getCurrentToolCallContext } from '@agent/followUp/ToolFileInteractionContext';
import { isFileNotFoundError, isNotADirectoryError } from '@common/errors';
import { hostPort } from '@common/hostPort';
import { effectRuntime } from '@platform/processRuntime';
import { ToolError, ToolResult } from '@shared/schemas';
import { getGitignoreMatcher } from '@tools/gitignore';
import { formatToolOutput } from '@tools/formatting';
import {
  joinWorkspaceRelativePath,
  resolveAndFormat,
  currentToolRoot,
} from '@tools/pathResolution';
import { executed } from '@tools/core/result';
import { filterNotNull } from '@utils/core';
import { WorkspaceFS } from '@utils/files/workspaceFS';
import { toPosixPath } from '@utils/core/pathCore';
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
  readonly signal: AbortSignal | undefined;
  readonly toolRoot: () => string | undefined;
}

const runGlob = Effect.fn('GlobTool.execute')(function* (
  ports: GlobPorts,
  input: GlobInput,
): Effect.fn.Return<ToolResult, unknown> {
  const root = ports.toolRoot();
  const { path, display } = resolveAndFormat(input.path ?? undefined, root);
  const gitignore = yield* getGitignoreMatcher();

  const cancelSignal = ports.signal;
  const matches = yield* Effect.tryPromise({
    try: () =>
      glob(input.pattern, {
        cwd: path.absolute,
        dot: true,
        nodir: false,
        absolute: false,
        // Large-tree walks stop promptly when the batch is aborted.
        signal: cancelSignal,
        follow: false,
      }),
    catch: (err) =>
      new ToolError(
        `Glob pattern error: ${toErrorMessage(err)}. ` +
          `Check syntax: use ** for recursive, * for single level. Example: "**/*.tex"`,
      ),
  });

  // The walk is done, but stat-ing every match on a large tree is itself
  // slow — bail before it so a cancelled batch doesn't wait out the
  // post-walk stat/sort phase across several concurrent glob calls.
  if (cancelSignal?.aborted) {
    return yield* Effect.fail(
      new ToolError('Cancelled before stat-ing glob matches.'),
    );
  }

  const statMatch = Effect.fn('GlobTool.statMatch')(function* (
    match: string,
  ): Effect.fn.Return<GlobMatchInfo | null, unknown> {
    const resolved = yield* Effect.try({
      try: () => joinWorkspaceRelativePath(path.relative, match, root),
      catch: (err) =>
        new ToolError(
          `Match resolved outside the working directory: ${match} (${toErrorMessage(err)})`,
        ),
    });

    const relativePath = resolved.relative;
    if (
      relativePath === '.' ||
      (!nodePath.isAbsolute(relativePath) && gitignore.ignores(relativePath))
    ) {
      return null;
    }

    return yield* hostPort(() => WorkspaceFS.stat(resolved.fsPath)).pipe(
      Effect.map((stat): GlobMatchInfo | null => ({
        relativePath,
        mtime: stat.mtime,
      })),
      // A match that vanished (or turned out not to be a directory) between
      // the walk and the stat is dropped; any other stat failure is real.
      Effect.catch((error) =>
        isFileNotFoundError(error) || isNotADirectoryError(error)
          ? Effect.succeed(null)
          : Effect.fail(error),
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

export class GlobTool extends defineTool({
  name: 'glob',
  parallelSafe: true,
  description:
    'Find files matching glob patterns (e.g., "**/*.tex", "src/**/*.ts"). Returns paths sorted by modification time.',
  schema: GlobInputSchema,
}) {
  protected execute(input: GlobInput): Promise<ToolResult> {
    // The working directory belongs to the calling turn, so it is bound here
    // and handed to the program rather than read from a fiber.
    const ports: GlobPorts = {
      signal: getCurrentToolCallContext()?.signal,
      toolRoot: AsyncLocalStorage.bind(currentToolRoot),
    };
    return effectRuntime().runPromise(runGlob(ports, input));
  }
}
