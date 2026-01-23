// Third-party imports
import { glob } from 'glob';
import { z } from 'zod';

// Local imports - tools
import { toErrorMessage } from '@common/errors';
import { ToolError, ToolResult } from '@tools/result';
import {
  joinWorkspaceRelativePath,
  resolveAndFormat,
  formatToolOutput,
  pluralize,
} from '@tools/utils';
import { getGitignoreMatcher } from '@tools/gitignore';
import { toPosixPath } from '@utils/core';
import { WorkspaceFS } from '@utils/files';

// Local file imports
import { defineTool } from './core/define';

const GlobInputSchema = z.strictObject({
  pattern: z
    .string()
    .min(1, 'pattern is required')
    .describe('Glob pattern like "**/*.tex" or "src/**/*.ts"'),
  path: z
    .string()
    .nullish()
    .describe('Directory to search. Defaults to workspace root.'),
});

export type GlobInput = z.infer<typeof GlobInputSchema>;

interface GlobMatchInfo {
  relativePath: string;
  mtime: number;
}

export class GlobTool extends defineTool({
  name: 'glob',
  description:
    'Find files matching glob patterns (e.g., "**/*.tex", "src/**/*.ts"). Returns paths sorted by modification time.',
  schema: GlobInputSchema,
}) {
  protected async execute(input: GlobInput): Promise<ToolResult> {
    const { path, display } = resolveAndFormat(input.path ?? undefined);
    const gitignore = await getGitignoreMatcher();

    let matches: string[];
    try {
      matches = await glob(input.pattern, {
        cwd: path.absolute,
        dot: true,
        nodir: false,
        absolute: false,
        follow: false,
      });
    } catch (err) {
      throw new ToolError(
        `Glob pattern error: ${toErrorMessage(err)}. ` +
          `Check syntax: use ** for recursive, * for single level. Example: "**/*.tex"`,
      );
    }

    // Process matches in parallel for better performance
    const statPromises = matches.map(
      async (match): Promise<GlobMatchInfo | null> => {
        let resolved;
        try {
          resolved = joinWorkspaceRelativePath(path.relative, match);
        } catch (err) {
          throw new ToolError(
            `Match resolved outside the workspace: ${match} (${toErrorMessage(err)})`,
          );
        }

        const relativePath =
          resolved.relative === '.' ? '.' : resolved.relative;
        if (relativePath === '.' || gitignore.ignores(relativePath)) {
          return null;
        }

        const stat = await WorkspaceFS.stat(relativePath).catch(() => null);
        return { relativePath, mtime: stat?.mtime ?? 0 };
      },
    );

    const results = await Promise.all(statPromises);
    const decorated = results.filter(
      (item): item is GlobMatchInfo => item !== null,
    );

    const sorted = decorated.sort((a, b) => {
      if (b.mtime !== a.mtime) {
        return b.mtime - a.mtime;
      }
      return a.relativePath.localeCompare(b.relativePath);
    });

    const lines = sorted.map((item) => toPosixPath(item.relativePath));
    const count = lines.length;
    const header = `Found ${count} ${pluralize(count, 'file')} matching "${input.pattern}" under ${display}`;
    return {
      summary: `Found ${count} ${pluralize(count, 'file')} for "${input.pattern}" in ${display}`,
      output: formatToolOutput(header, lines, '(no matches)'),
    };
  }
}
