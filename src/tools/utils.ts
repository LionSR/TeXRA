// Standard library imports
import * as path from 'path';

// Third-party imports
import { Minimatch } from 'minimatch';

// Local imports - tools
import { ToolError } from '@tools/result';
import { toPosixPath } from '@tools/pathUtils';

// Local imports - utils
import { WorkspaceFS } from '@utils/files';

/**
 * Helper function to truncate long output for logging
 *
 * @param text Text to truncate
 * @param maxLength Maximum length before truncation
 * @returns Truncated text if needed
 */
export function maybe_truncate(text: string, maxLength: number = 5000): string {
  if (text.length <= maxLength) {
    return text;
  }

  const truncatedText =
    text.substring(0, maxLength) +
    `\n...(truncated, ${text.length - maxLength} more characters)`;
  return truncatedText;
}

export interface WorkspacePathResolution {
  relative: string;
  absolute: string;
}

/**
 * Resolve a potentially absolute or relative path against the workspace root.
 *
 * The returned relative path is normalized and guaranteed to remain inside the
 * workspace. Throws if the workspace folder cannot be determined or if the
 * resolved location would escape the workspace root.
 */
export function resolveWorkspaceRelativePath(
  targetPath?: string,
): WorkspacePathResolution {
  const workspacePath = WorkspaceFS.getPath();
  if (!workspacePath) {
    throw new ToolError('Workspace path is not available.');
  }

  if (!targetPath || targetPath.trim() === '' || targetPath === '.') {
    return {
      relative: '.',
      absolute: workspacePath,
    };
  }

  const trimmed = targetPath.trim();
  const absoluteCandidate = path.resolve(workspacePath, trimmed);
  const relativeCandidate = path.relative(workspacePath, absoluteCandidate);
  const normalizedRelative =
    relativeCandidate === '' ? '.' : path.normalize(relativeCandidate);

  const segments = normalizedRelative.split(path.sep).filter(Boolean);
  if (segments.some((segment) => segment === '..')) {
    throw new ToolError('Path must stay within the workspace.');
  }

  return {
    relative: normalizedRelative,
    absolute: absoluteCandidate,
  };
}

/**
 * Join a workspace-relative base path with a child segment and ensure the
 * result stays within the workspace root.
 */
export function joinWorkspaceRelativePath(
  baseRelative: string,
  child: string,
): WorkspacePathResolution {
  const base = baseRelative && baseRelative !== '.' ? baseRelative : '.';
  const combined = base === '.' ? child : path.join(base, child);
  return resolveWorkspaceRelativePath(combined);
}

/**
 * Compile a glob pattern into a matcher that operates on POSIX-style paths.
 * Supports `*`, `?`, and `**` tokens.
 */
export function createGlobMatcher(pattern: string): (value: string) => boolean {
  const matcher = new Minimatch(pattern, {
    dot: true,
    matchBase: true,
    nocase: false,
  });

  return (value: string) => matcher.match(value.replace(/\\/g, '/'));
}

export { toPosixPath } from '@tools/pathUtils';

// Re-export gitignore utilities from standalone module
export { getGitignoreMatcher, clearGitignoreCache } from './gitignore';
export type { GitignoreMatcher } from './gitignore';

/**
 * Format tool output with a header and content.
 */
export function formatToolOutput(
  header: string,
  content: string | string[] | null,
  noMatchesText: string = '(no entries)',
): string {
  if (!content || (Array.isArray(content) && content.length === 0)) {
    return `${header}\n${noMatchesText}`;
  }
  const lines = Array.isArray(content) ? content.join('\n') : content;
  return `${header}\n${lines}`;
}

/**
 * Common pattern for resolving and formatting workspace paths.
 */
export function resolveAndFormat(path?: string): {
  resolved: WorkspacePathResolution;
  display: string;
} {
  const resolved = resolveWorkspaceRelativePath(path);
  const display = toPosixPath(resolved.relative);
  return { resolved, display };
}
