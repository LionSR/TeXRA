// Third-party imports
import * as vscode from 'vscode';
import { z } from 'zod';

// Local imports - core
import { defineTool } from './core/define';

// Local imports - tools
import { ToolError, ToolResult } from '@tools/result';
import {
  createGlobMatcher,
  joinWorkspaceRelativePath,
  resolveWorkspaceRelativePath,
  toPosixPath,
} from '@tools/utils';

// Local imports - utils
import { WorkspaceFS } from '@utils/files';

const LsInputSchema = z
  .object({
    path: z.string(),
    ignore: z.array(z.string()).optional(),
  })
  .strict();

export type LsInput = z.infer<typeof LsInputSchema>;

function formatEntry(name: string, type: vscode.FileType): string {
  const suffix = type === vscode.FileType.Directory ? '/' : '';
  const label =
    type === vscode.FileType.Directory
      ? 'dir '
      : type === vscode.FileType.SymbolicLink
        ? 'link'
        : type === vscode.FileType.File
          ? 'file'
          : 'other';
  return `${label.padEnd(4, ' ')} ${name}${suffix}`;
}

export class LsTool extends defineTool({
  name: 'ls',
  description:
    'Lists files and directories in a given path within the workspace',
  schema: LsInputSchema,
}) {
  protected async execute(input: LsInput): Promise<ToolResult> {
    const target = resolveWorkspaceRelativePath(input.path);
    const relative = target.relative === '.' ? '.' : target.relative;

    let stats: vscode.FileStat | undefined;
    try {
      stats = await WorkspaceFS.stat(relative);
    } catch {
      throw new ToolError(`Path not found: ${toPosixPath(target.relative)}`);
    }

    const ignoreMatchers = (input.ignore ?? []).map(createGlobMatcher);
    const shouldIgnore = (entryPath: string) =>
      ignoreMatchers.some((matcher) => matcher(entryPath));

    if (stats.type === vscode.FileType.File) {
      const entryPath = toPosixPath(target.relative);
      if (shouldIgnore(entryPath)) {
        return new ToolResult({
          output: `Listing for ${entryPath}\n(no entries after applying ignore filters)`,
        });
      }
      return new ToolResult({
        output: `Listing for ${entryPath}\n${formatEntry(entryPath, vscode.FileType.File)}`,
      });
    }

    const entries = await WorkspaceFS.readDir(relative);
    const filtered = entries.filter(([name]) => {
      if (ignoreMatchers.length === 0) {
        return true;
      }
      const resolvedChild = joinWorkspaceRelativePath(target.relative, name);
      const entryPath = toPosixPath(resolvedChild.relative);
      return !shouldIgnore(entryPath) && !shouldIgnore(name);
    });

    const sorted = filtered.sort(([a], [b]) => a.localeCompare(b));
    const formatted = sorted
      .map(([name, type]) => formatEntry(name, type))
      .join('\n');
    const header = `Listing for ${toPosixPath(target.relative)}`;
    const output = formatted
      ? `${header}\n${formatted}`
      : `${header}\n(no entries)`;

    return new ToolResult({ output });
  }
}
