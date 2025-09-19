// Standard library imports
import * as path from 'path';

// Third-party imports
import { glob } from 'glob';
import { z } from 'zod';

// Local imports - core
import { defineTool } from './core/define';

// Local imports - tools
import { ToolResult, ToolError } from './result';
import {
  NormalizedFileType,
  fileTypeToString,
  normalizeRelativeForOutput,
  resolvePathWithinWorkspace,
  toWorkspaceRelativePath,
} from './utils';
import { WorkspaceFS } from '@utils/files';

const GlobInputSchema = z.object({
  pattern: z.string(),
  path: z.string().optional(),
});

export type GlobInput = z.infer<typeof GlobInputSchema>;

type GlobMatch = {
  path: string;
  type: NormalizedFileType;
  mtime: number;
};

export class GlobTool extends defineTool({
  name: 'glob',
  description:
    'Find files by pattern within the workspace and sort by modification time',
  schema: GlobInputSchema,
}) {
  protected async execute(input: GlobInput): Promise<ToolResult> {
    const resolved = resolvePathWithinWorkspace(input.path);
    const baseAbsolute = resolved.absolutePath ?? resolved.workspacePath;
    const baseRelative = resolved.relativePath ?? '.';

    let matches: string[];
    try {
      matches = await glob(input.pattern, {
        cwd: baseAbsolute,
        dot: true,
        withFileTypes: false,
        nocase: false,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ToolError(`Glob search failed: ${message}`);
    }

    const workspaceMatches = await Promise.all(
      matches.map(async (matchPath) => {
        const absoluteMatch = path.join(baseAbsolute, matchPath);
        let workspaceRelative: string;
        try {
          workspaceRelative = toWorkspaceRelativePath(
            resolved.workspacePath,
            absoluteMatch,
          );
        } catch {
          return null;
        }

        try {
          const stats = await WorkspaceFS.stat(
            workspaceRelative === '.' ? '.' : workspaceRelative,
          );
          const entry: GlobMatch = {
            path: normalizeRelativeForOutput(workspaceRelative),
            type: fileTypeToString(stats.type),
            mtime: stats.mtime,
          };
          return entry;
        } catch {
          return null;
        }
      }),
    );

    const filteredMatches = workspaceMatches
      .filter((entry): entry is GlobMatch => entry !== null)
      .sort((a, b) => b.mtime - a.mtime);

    const output = {
      basePath: normalizeRelativeForOutput(baseRelative),
      pattern: input.pattern,
      matches: filteredMatches.map((entry) => ({
        path: entry.path,
        type: entry.type,
        mtime: new Date(entry.mtime).toISOString(),
      })),
    };

    return new ToolResult({ output: JSON.stringify(output) });
  }
}
