// Third-party imports
import * as vscode from 'vscode';
import { z } from 'zod';

// Local imports - tools
import { toErrorMessage } from '@common/errors';
import { ToolError, ToolResult } from '@tools/result';
import {
  createGlobMatcher,
  joinWorkspaceRelativePath,
  resolveAndFormat,
  formatToolOutput,
} from '@tools/utils';
import { getGitignoreMatcher } from '@tools/gitignore';
import { toPosixPath } from '@utils/core';
import { WorkspaceFS } from '@utils/files';

// Local file imports
import { defineTool } from './core/define';

const LsInputSchema = z.strictObject({
  path: z.string(),
  ignore: z.array(z.string()).prefault([]),
});

export type LsInput = z.infer<typeof LsInputSchema>;

const DEFAULT_HIDDEN_NAMES = new Set(['.git', '.gitignore']);

function isDefaultHiddenName(name: string): boolean {
  return DEFAULT_HIDDEN_NAMES.has(name);
}

const FILE_TYPE_LABELS: Record<vscode.FileType, string> = {
  [vscode.FileType.Directory]: 'dir',
  [vscode.FileType.SymbolicLink]: 'link',
  [vscode.FileType.File]: 'file',
  [vscode.FileType.Unknown]: 'other',
};

function getFileTypeLabel(type: vscode.FileType): string {
  return FILE_TYPE_LABELS[type] ?? 'other';
}

function formatEntry(name: string, type: vscode.FileType): string {
  const suffix = type === vscode.FileType.Directory ? '/' : '';
  const label = getFileTypeLabel(type);
  return `${label.padEnd(4, ' ')} ${name}${suffix}`;
}

export class LsTool extends defineTool({
  name: 'ls',
  description:
    'List files and directories. Supports glob patterns for filtering.',
  schema: LsInputSchema,
}) {
  protected async execute(input: LsInput): Promise<ToolResult> {
    const { resolved, display } = resolveAndFormat(input.path);
    const gitignore = await getGitignoreMatcher();
    const summary = `Listing for ${display}`;

    let stats: vscode.FileStat | undefined;
    try {
      stats = await WorkspaceFS.stat(resolved.relative);
    } catch (err) {
      const message = toErrorMessage(err);
      throw new ToolError(`Path not found: ${display} (${message})`);
    }

    const ignoreMatchers = input.ignore.map(createGlobMatcher);
    // Empty array.some() returns false, so no special case needed
    const matchesCustomIgnore = (entryPath: string): boolean =>
      ignoreMatchers.some((matcher) => matcher(entryPath));

    if (stats.type === vscode.FileType.File) {
      const relativePosix = toPosixPath(resolved.relative);
      const fileName = relativePosix.split('/').at(-1) ?? relativePosix;
      if (
        isDefaultHiddenName(fileName) ||
        gitignore.ignores(resolved.relative) ||
        matchesCustomIgnore(display) ||
        matchesCustomIgnore(relativePosix)
      ) {
        return {
          summary,
          output: formatToolOutput(
            `Listing for ${display}`,
            null,
            '(no entries after applying ignore filters)',
          ),
        };
      }
      return {
        summary,
        output: formatToolOutput(
          `Listing for ${display}`,
          formatEntry(display, vscode.FileType.File),
        ),
      };
    }

    if (resolved.relative !== '.' && gitignore.ignores(resolved.relative)) {
      return {
        summary,
        output: formatToolOutput(
          `Listing for ${display}`,
          null,
          '(no entries after applying ignore filters)',
        ),
      };
    }

    const entries = await WorkspaceFS.readDir(resolved.relative);
    const filtered = entries.filter(([name]) => {
      if (isDefaultHiddenName(name)) {
        return false;
      }
      const resolvedChild = joinWorkspaceRelativePath(resolved.relative, name);
      const entryPath = toPosixPath(resolvedChild.relative);
      return (
        !gitignore.ignores(resolvedChild.relative) &&
        !matchesCustomIgnore(entryPath) &&
        !matchesCustomIgnore(name)
      );
    });

    const sorted = filtered.sort(([a], [b]) => a.localeCompare(b));
    const formatted = sorted.map(([name, type]) => formatEntry(name, type));

    return {
      summary,
      output: formatToolOutput(`Listing for ${display}`, formatted),
    };
  }
}
