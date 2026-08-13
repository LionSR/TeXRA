// Node imports
import * as nodePath from 'node:path';

// Third-party imports
import { glob } from 'glob';
import { z } from 'zod';

// Local imports
import { getCurrentToolCallContext } from '@agent/followUp/ToolFileInteractionContext';
import { isFileNotFoundError, isNotADirectoryError } from '@common/errors';
import { ToolError, ToolResult } from '@shared/schemas';
import { getGitignoreMatcher } from '@tools/gitignore';
import { formatToolOutput } from '@tools/formatting';
import {
  joinWorkspaceRelativePath,
  resolveAndFormat,
  currentToolRoot,
  type WorkspacePathResolution,
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

export class GlobTool extends defineTool({
  name: 'glob',
  parallelSafe: true,
  description:
    'Find files matching glob patterns (e.g., "**/*.tex", "src/**/*.ts"). Returns paths sorted by modification time.',
  schema: GlobInputSchema,
}) {
  protected async execute(input: GlobInput): Promise<ToolResult> {
    const root = currentToolRoot();
    const { path, display } = resolveAndFormat(input.path ?? undefined, root);
    const gitignore = await getGitignoreMatcher();

    const cancelSignal = getCurrentToolCallContext()?.signal;
    let matches: string[];
    try {
      matches = await glob(input.pattern, {
        cwd: path.absolute,
        dot: true,
        nodir: false,
        absolute: false,
        // Large-tree walks stop promptly when the batch is aborted.
        signal: cancelSignal,
        follow: false,
      });
    } catch (err) {
      throw new ToolError(
        `Glob pattern error: ${toErrorMessage(err)}. ` +
          `Check syntax: use ** for recursive, * for single level. Example: "**/*.tex"`,
      );
    }

    // The walk is done, but stat-ing every match on a large tree is itself
    // slow — bail before it so a cancelled batch doesn't wait out the
    // post-walk stat/sort phase across several concurrent glob calls.
    if (cancelSignal?.aborted) {
      throw new ToolError('Cancelled before stat-ing glob matches.');
    }

    // Process matches in parallel for better performance
    const statPromises = matches.map(
      async (match): Promise<GlobMatchInfo | null> => {
        let resolved: WorkspacePathResolution;
        try {
          resolved = joinWorkspaceRelativePath(path.relative, match, root);
        } catch (err) {
          throw new ToolError(
            `Match resolved outside the working directory: ${match} (${toErrorMessage(err)})`,
          );
        }

        const relativePath = resolved.relative;
        if (
          relativePath === '.' ||
          (!nodePath.isAbsolute(relativePath) &&
            gitignore.ignores(relativePath))
        ) {
          return null;
        }

        try {
          const stat = await WorkspaceFS.stat(resolved.fsPath);
          return { relativePath, mtime: stat.mtime };
        } catch (error) {
          if (isFileNotFoundError(error) || isNotADirectoryError(error)) {
            return null;
          }
          throw error;
        }
      },
    );

    const results = await Promise.all(statPromises);
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
  }
}
