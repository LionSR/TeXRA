// Third-party imports
import { glob } from 'glob';
import { z } from 'zod';

// Local imports - core
import { defineTool } from './core/define';

// Local imports - tools
import { ToolError, ToolResult } from '@tools/result';
import {
  joinWorkspaceRelativePath,
  resolveWorkspaceRelativePath,
  toPosixPath,
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
  description: 'Fast file pattern matching within the workspace',
  schema: GlobInputSchema,
}) {
  protected async execute(input: GlobInput): Promise<ToolResult> {
    const base = resolveWorkspaceRelativePath(input.path);

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
      if (relativePath === '.') {
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

    const displayBase = toPosixPath(base.relative);
    const header = `Matches for pattern "${input.pattern}" under ${displayBase}`;
    if (sorted.length === 0) {
      return new ToolResult({ output: `${header}\n(no matches)` });
    }

    const lines = sorted.map((item) => toPosixPath(item.relativePath));
    return new ToolResult({ output: `${header}\n${lines.join('\n')}` });
  }
}
