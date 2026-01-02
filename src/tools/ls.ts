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
      const message = toErrorMessage(err);
      throw new ToolError(`Path not found: ${display} (${message})`);
    }

    const ignoreMatchers = input.ignore.map(createGlobMatcher);
    const matchesCustomIgnore =
      input.ignore.length === 0
        ? () => false
        : (entryPath: string) =>
            ignoreMatchers.some((matcher) => matcher(entryPath));

    if (stats.type === vscode.FileType.File) {
      const relativePosix = toPosixPath(relative);
      const fileName = relativePosix.split('/').at(-1) ?? relativePosix;
      if (
        isDefaultHiddenName(fileName) ||
        gitignore.ignores(relative) ||
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
        });
      }
      return {
        summary,
        output: formatToolOutput(
          `Listing for ${display}`,
          formatEntry(display, vscode.FileType.File),
        ),
      });
    }

    if (relative !== '.' && gitignore.ignores(relative)) {
      return {
        summary,
        output: formatToolOutput(
          `Listing for ${display}`,
          null,
          '(no entries after applying ignore filters)',
        ),
      });
    }

    const entries = await WorkspaceFS.readDir(relative);
    const filtered = entries.filter(([name, _type]) => {
      const resolvedChild = joinWorkspaceRelativePath(target.relative, name);
      const entryRelative = resolvedChild.relative;
      const entryPath = toPosixPath(entryRelative);
      if (isDefaultHiddenName(name)) {
        return false;
      }
      if (gitignore.ignores(entryRelative)) {
        return false;
      }
      if (matchesCustomIgnore(entryPath) || matchesCustomIgnore(name)) {
        return false;
      }
      return true;
    });

    const sorted = filtered.sort(([a], [b]) => a.localeCompare(b));
    const formatted = sorted.map(([name, type]) => formatEntry(name, type));

    return {
      summary,
      output: formatToolOutput(`Listing for ${display}`, formatted),
    });
  }
}
