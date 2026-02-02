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
  pluralize,
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

const NO_ENTRIES_MESSAGE = '(no entries after applying ignore filters)';

export class LsTool extends defineTool({
  name: 'ls',
  description:
    'List files and directories. Supports glob patterns for filtering.',
  schema: LsInputSchema,
}) {
  protected async execute(input: LsInput): Promise<ToolResult> {
    const { path: resolved, display } = resolveAndFormat(input.path);
    const gitignore = await getGitignoreMatcher();
    const header = `Listing for ${display}`;

    const makeResult = (
      content: string | string[] | null,
      summary = header,
    ): ToolResult => ({
      summary,
      output: formatToolOutput(header, content, NO_ENTRIES_MESSAGE),
    });

    let stats: vscode.FileStat | undefined;
    try {
      stats = await WorkspaceFS.stat(resolved.relative);
    } catch (err) {
      const message = toErrorMessage(err);
      throw new ToolError(
        `Path not found: ${display} (${message}). ` +
          `Try: Use glob to search for files, or ls on parent directory.`,
      );
    }

    const ignoreMatchers = input.ignore.map(createGlobMatcher);
    const matchesCustomIgnore = (entryPath: string): boolean =>
      ignoreMatchers.some((matcher) => matcher(entryPath));

    if (stats.type === vscode.FileType.File) {
      const relativePosix = toPosixPath(resolved.relative);
      const fileName = relativePosix.split('/').at(-1) ?? relativePosix;
      const isIgnored =
        isDefaultHiddenName(fileName) ||
        gitignore.ignores(resolved.relative) ||
        matchesCustomIgnore(display) ||
        matchesCustomIgnore(relativePosix);
      return makeResult(
        isIgnored ? null : formatEntry(display, vscode.FileType.File),
      );
    }

    if (resolved.relative !== '.' && gitignore.ignores(resolved.relative)) {
      return makeResult(null);
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
    const count = formatted.length;

    return makeResult(
      formatted,
      `Listed ${count} ${pluralize(count, 'entry', 'entries')} in ${display}`,
    );
  }
}
