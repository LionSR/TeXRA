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
} from '@tools/utils';
import { getGitignoreMatcher } from '@tools/gitignore';
import { toPosixPath } from '@utils/core';
import { WorkspaceFS } from '@utils/files';
import { executeCommand } from '@utils/system/execUtils';

// Local file imports
import { defineTool } from './core/define';

const GlobInputSchema = z.strictObject({
  pattern: z.string().min(1, 'pattern is required'),
  path: z.string().nullish(),
});

export type GlobInput = z.infer<typeof GlobInputSchema>;

interface GlobMatchInfo {
  relativePath: string;
  mtime: number;
  lineCount: number | null;
}

/**
 * Count lines for multiple files using `wc -l` (efficient, streams files).
 * Returns a map from relative path to line count.
 */
async function countLinesForFiles(
  filePaths: string[],
): Promise<Map<string, number>> {
  const lineCounts = new Map<string, number>();
  if (filePaths.length === 0) {
    return lineCounts;
  }

  // Batch files to avoid command line length limits
  const BATCH_SIZE = 100;
  for (let i = 0; i < filePaths.length; i += BATCH_SIZE) {
    const batch = filePaths.slice(i, i + BATCH_SIZE);
    const result = await executeCommand(['wc', '-l', ...batch], {
      channel: 'GlobTool',
    });

    if (result.success && result.stdout) {
      // Parse wc -l output: "  123 path/to/file"
      for (const line of result.stdout.split('\n')) {
        const match = line.match(/^\s*(\d+)\s+(.+)$/);
        if (match) {
          const [, count, path] = match;
          // Skip "total" line that wc outputs when given multiple files
          if (path !== 'total') {
            lineCounts.set(path, parseInt(count, 10));
          }
        }
      }
    }
  }

  return lineCounts;
}

export class GlobTool extends defineTool({
  name: 'glob',
  description:
    'Find files matching glob patterns (e.g., "**/*.tex", "src/**/*.ts"). Returns paths sorted by modification time.',
  schema: GlobInputSchema,
}) {
  protected async execute(input: GlobInput): Promise<ToolResult> {
    const { resolved: base, display } = resolveAndFormat(
      input.path ?? undefined,
    );
    const gitignore = await getGitignoreMatcher();

    let matches: string[];
    try {
      matches = await glob(input.pattern, {
        cwd: base.absolute,
        dot: true,
        nodir: false,
        absolute: false,
        follow: false,
      });
    } catch (err) {
      throw new ToolError(`glob error: ${toErrorMessage(err)}`);
    }

    // Process matches in parallel for better performance
    const statPromises = matches.map(async (match) => {
      let resolved;
      try {
        resolved = joinWorkspaceRelativePath(base.relative, match);
      } catch (err) {
        throw new ToolError(
          `Match resolved outside the workspace: ${match} (${toErrorMessage(err)})`,
        );
      }

      const relativePath = resolved.relative === '.' ? '.' : resolved.relative;
      if (relativePath === '.' || gitignore.ignores(relativePath)) {
        return null;
      }

      try {
        const stat = await WorkspaceFS.stat(relativePath);
        return {
          relativePath,
          mtime: stat.mtime ?? 0,
          isFile: stat.isFile,
        };
      } catch (_err) {
        return { relativePath, mtime: 0, isFile: false };
      }
    });

    const decoratedWithNulls = await Promise.all(statPromises);
    const statsOnly = decoratedWithNulls.filter(
      (item): item is { relativePath: string; mtime: number; isFile: boolean } =>
        item !== null,
    );

    // Sort by mtime first, then count lines only for top N files
    const sorted = statsOnly.sort((a, b) => {
      if (b.mtime !== a.mtime) {
        return b.mtime - a.mtime;
      }
      return a.relativePath.localeCompare(b.relativePath);
    });

    // Count lines for files using wc -l, but limit to avoid slowdowns on large results
    const LINE_COUNT_LIMIT = 50;
    const filesToCount = sorted
      .filter((item) => item.isFile)
      .slice(0, LINE_COUNT_LIMIT)
      .map((item) => item.relativePath);
    const lineCounts = await countLinesForFiles(filesToCount);

    const decorated: GlobMatchInfo[] = sorted.map((item) => ({
      relativePath: item.relativePath,
      mtime: item.mtime,
      lineCount: item.isFile ? (lineCounts.get(item.relativePath) ?? null) : null,
    }));

    const header = `Matches for pattern "${input.pattern}" under ${display}`;
    const lines = decorated.map((item) => {
      const path = toPosixPath(item.relativePath);
      if (item.lineCount !== null) {
        return `${path} (${item.lineCount} lines)`;
      }
      return path;
    });
    return {
      summary: `glob "${input.pattern}" under ${display}`,
      output: formatToolOutput(header, lines, '(no matches)'),
    };
  }
}
