// Third-party imports
import { glob } from 'glob';
import { z } from 'zod';

// Local imports - core
import { defineTool } from './core/define';

// Local imports - tools
import { ToolError, ToolResult } from '@tools/result';
import {
  joinWorkspaceRelativePath,
  resolveAndFormat,
  formatToolOutput,
  toPosixPath,
  getGitignoreMatcher,
} from '@tools/utils';

// Local imports - utils
import { WorkspaceFS } from '@utils/files';

const GlobInputSchema = z
  .object({
    pattern: z.string().min(1, 'pattern is required'),
    path: z.string().optional(),
  })
  .strict();

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
    const { resolved: base, display } = resolveAndFormat(input.path);
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
      const message = err instanceof Error ? err.message : String(err);
      throw new ToolError(`glob error: ${message}`);
    }

    const decorated: GlobMatchInfo[] = [];
    for (const match of matches) {
      let resolved;
      try {
        resolved = joinWorkspaceRelativePath(base.relative, match);
      } catch (err) {
        throw new ToolError(
          `Match resolved outside the workspace: ${match} (${err instanceof Error ? err.message : String(err)})`,
        );
      }

      const relativePath = resolved.relative === '.' ? '.' : resolved.relative;
      if (relativePath === '.' || gitignore.ignores(relativePath)) {
        continue;
      }

      try {
        const stat = await WorkspaceFS.stat(relativePath);
        decorated.push({
          relativePath,
          mtime: stat.mtime ?? 0,
        });
      } catch {
        decorated.push({ relativePath, mtime: 0 });
      }
    }

    const sorted = decorated.sort((a, b) => {
      if (b.mtime !== a.mtime) {
        return b.mtime - a.mtime;
      }
      return a.relativePath.localeCompare(b.relativePath);
    });

    const header = `Matches for pattern "${input.pattern}" under ${display}`;
    const lines = sorted.map((item) => toPosixPath(item.relativePath));
    return new ToolResult({
      output: formatToolOutput(header, lines, '(no matches)'),
    });
  }
}
