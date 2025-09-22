// Third-party imports
import * as vscode from 'vscode';
import { z } from 'zod';

// Local imports - core
import { defineTool } from './core/define';

// Local imports - tools
import { ToolError, ToolResult, toolResult } from '@tools/result';
import {
  createGlobMatcher,
  joinWorkspaceRelativePath,
  resolveAndFormat,
  formatToolOutput,
  toPosixPath,
} from '@tools/utils';
import { getGitignoreMatcher } from '@tools/gitignore';

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
    'List files and directories. Supports glob patterns for filtering.',
  schema: LsInputSchema,
}) {
  protected async execute(input: LsInput): Promise<ToolResult> {
    const { resolved: target, display } = resolveAndFormat(input.path);
    const relative = target.relative === '.' ? '.' : target.relative;
    const gitignore = await getGitignoreMatcher();
    const summary = `Listing for ${display}`;

    let stats: vscode.FileStat | undefined;
    try {
      stats = await WorkspaceFS.stat(relative);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new ToolError(`Path not found: ${display} (${message})`);
    }

    const ignorePatterns = input.ignore ?? [];
    const ignoreMatchers = ignorePatterns.map(createGlobMatcher);
    const matchesCustomIgnore =
      ignorePatterns.length === 0
        ? () => false
        : (entryPath: string) =>
            ignoreMatchers.some((matcher) => matcher(entryPath));

    if (stats.type === vscode.FileType.File) {
      const relativePosix = toPosixPath(relative);
      if (
        gitignore.ignores(relative) ||
        matchesCustomIgnore(display) ||
        matchesCustomIgnore(relativePosix)
      ) {
        return toolResult({
          summary,
          output: formatToolOutput(
            `Listing for ${display}`,
            null,
            '(no entries after applying ignore filters)',
          ),
        });
      }
      return toolResult({
        summary,
        output: formatToolOutput(
          `Listing for ${display}`,
          formatEntry(display, vscode.FileType.File),
        ),
      });
    }

    if (relative !== '.' && gitignore.ignores(relative)) {
      return toolResult({
        summary,
        output: formatToolOutput(
          `Listing for ${display}`,
          null,
          '(no entries after applying ignore filters)',
        ),
      });
    }

    const entries = await WorkspaceFS.readDir(relative);
    const shouldFilter = ignorePatterns.length > 0 || gitignore.hasRules;
    const filtered = shouldFilter
      ? entries.filter(([name, _type]) => {
          const resolvedChild = joinWorkspaceRelativePath(
            target.relative,
            name,
          );
          const entryRelative = resolvedChild.relative;
          const entryPath = toPosixPath(entryRelative);
          if (gitignore.ignores(entryRelative)) {
            return false;
          }
          if (matchesCustomIgnore(entryPath) || matchesCustomIgnore(name)) {
            return false;
          }
          return true;
        })
      : entries;

    const sorted = filtered.sort(([a], [b]) => a.localeCompare(b));
    const formatted = sorted.map(([name, type]) => formatEntry(name, type));

    return toolResult({
      summary,
      output: formatToolOutput(`Listing for ${display}`, formatted),
    });
  }
}
