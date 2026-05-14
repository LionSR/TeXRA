// Standard library imports
import * as path from 'path';

// Third-party imports
import { z } from 'zod';

// Local imports - tools
import { toErrorMessage } from '@common/errors';
import { isFile, isDirectory } from '@common/files/fsEntryType';
import { ToolError, ToolResult } from '@tools/result';
import { formatToolOutput, pluralize } from '@tools/formatting';
import {
  joinWorkspaceRelativePath,
  resolveAndFormat,
  currentToolRoot,
} from '@tools/pathResolution';
import { createGlobMatcher } from '@tools/utils';
import { getGitignoreMatcher } from '@tools/gitignore';
import { WorkspaceFS } from '@utils/files';
import { toPosixPath } from '@utils/core/pathCore';

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

function getFileTypeLabel(type: number): string {
  if (isDirectory(type)) return 'dir';
  if (isFile(type)) return 'file';
  return 'other';
}

function formatEntry(name: string, type: number): string {
  const suffix = isDirectory(type) ? '/' : '';
  const label = getFileTypeLabel(type);
  return `${label.padEnd(4)} ${name}${suffix}`;
}

const NO_ENTRIES_MESSAGE = '(no entries after applying ignore filters)';

export class LsTool extends defineTool({
  name: 'ls',
  description:
    'List files and directories. Supports glob patterns for filtering.',
  schema: LsInputSchema,
}) {
  protected async execute(input: LsInput): Promise<ToolResult> {
    const root = currentToolRoot();
    const { path: resolved, display } = resolveAndFormat(input.path, root);
    const gitignore = await getGitignoreMatcher();
    const header = `Listing for ${display}`;

    const makeResult = (
      content: string | string[] | null,
      summary = header,
    ): ToolResult => ({
      summary,
      output: formatToolOutput(header, content, NO_ENTRIES_MESSAGE),
    });

    let statType: number;
    try {
      const stats = await WorkspaceFS.stat(resolved.fsPath);
      statType = stats.type;
    } catch (err) {
      const message = toErrorMessage(err);
      throw new ToolError(
        `Path not found: ${display} (${message}).\n` +
          `To fix, either:\n` +
          `- Use the glob tool to find matching files: { "pattern": "**/<filename>" }\n` +
          `- List the parent directory to see what exists: { "path": "<parent>" }`,
      );
    }

    const ignoreMatchers = input.ignore.map(createGlobMatcher);
    const matchesCustomIgnore = (entryPath: string): boolean =>
      ignoreMatchers.some((matcher) => matcher(entryPath));

    if (isFile(statType)) {
      const relativePosix = toPosixPath(resolved.relative);
      const fileName = path.basename(resolved.relative);
      const isIgnored =
        isDefaultHiddenName(fileName) ||
        gitignore.ignores(resolved.relative) ||
        matchesCustomIgnore(display) ||
        matchesCustomIgnore(relativePosix);
      return makeResult(isIgnored ? null : formatEntry(display, statType));
    }

    if (resolved.relative !== '.' && gitignore.ignores(resolved.relative)) {
      return makeResult(null);
    }

    const entries = await WorkspaceFS.readDir(resolved.fsPath);
    const filtered = entries.filter(([name]) => {
      if (isDefaultHiddenName(name)) {
        return false;
      }
      const resolvedChild = joinWorkspaceRelativePath(
        resolved.relative,
        name,
        root,
      );
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
