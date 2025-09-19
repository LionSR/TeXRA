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
  resolveAndFormat,
  formatToolOutput,
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
  description: 'List files and directories. Supports glob patterns for filtering.',
  schema: LsInputSchema,
}) {
  protected async execute(input: LsInput): Promise<ToolResult> {
    const { resolved: target, display } = resolveAndFormat(input.path);
    const relative = target.relative === '.' ? '.' : target.relative;

    let stats: vscode.FileStat | undefined;
    try {
      stats = await WorkspaceFS.stat(relative);
    } catch {
      throw new ToolError(`Path not found: ${display}`);
    }

    const ignorePatterns = input.ignore ?? [];
    const ignoreMatchers = ignorePatterns.map(createGlobMatcher);
    const shouldIgnore = ignorePatterns.length === 0 
      ? () => false
      : (entryPath: string) => ignoreMatchers.some((matcher) => matcher(entryPath));

    if (stats.type === vscode.FileType.File) {
      if (shouldIgnore(display)) {
        return new ToolResult({
          output: formatToolOutput(
            `Listing for ${display}`, 
            null, 
            '(no entries after applying ignore filters)'
          ),
        });
      }
      return new ToolResult({
        output: formatToolOutput(
          `Listing for ${display}`,
          formatEntry(display, vscode.FileType.File)
        ),
      });
    }

    const entries = await WorkspaceFS.readDir(relative);
    const filtered = ignorePatterns.length === 0
      ? entries
      : entries.filter(([name]) => {
          const resolvedChild = joinWorkspaceRelativePath(target.relative, name);
          const entryPath = toPosixPath(resolvedChild.relative);
          return !shouldIgnore(entryPath) && !shouldIgnore(name);
        });

    const sorted = filtered.sort(([a], [b]) => a.localeCompare(b));
    const formatted = sorted.map(([name, type]) => formatEntry(name, type));
    
    return new ToolResult({
      output: formatToolOutput(`Listing for ${display}`, formatted),
    });
  }
}
