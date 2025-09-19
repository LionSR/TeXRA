// Standard library imports
import * as path from 'path';

// Third-party imports
import * as vscode from 'vscode';

// Local imports - tools
import { ToolError } from './result';
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

export type NormalizedFileType =
  | 'file'
  | 'directory'
  | 'symbolicLink'
  | 'unknown';

/**
 * Normalize the VS Code file type flag into a human-readable value.
 */
export function fileTypeToString(
  fileType: vscode.FileType,
): NormalizedFileType {
  if ((fileType & vscode.FileType.SymbolicLink) !== 0) {
    return 'symbolicLink';
  }
  if ((fileType & vscode.FileType.Directory) !== 0) {
    return 'directory';
  }
  if ((fileType & vscode.FileType.File) !== 0) {
    return 'file';
  }
  return 'unknown';
}

export interface ResolvedWorkspacePath {
  workspacePath: string;
  relativePath: string | null;
  absolutePath: string | null;
}

/**
 * Resolve an arbitrary path so that it stays inside the current workspace.
 *
 * Paths may be absolute or relative to the workspace root. The returned
 * relative path always uses the workspace as its base and collapses the root
 * directory to `.` for consistent handling.
 */
export function resolvePathWithinWorkspace(
  targetPath?: string,
): ResolvedWorkspacePath {
  const workspacePath = WorkspaceFS.getPath();
  if (!workspacePath) {
    throw new ToolError('Workspace path not found');
  }

  if (!targetPath || targetPath.trim().length === 0) {
    return {
      workspacePath,
      relativePath: null,
      absolutePath: null,
    };
  }

  const normalizedInput = path.normalize(targetPath);
  const candidateAbsolute = path.isAbsolute(normalizedInput)
    ? normalizedInput
    : path.join(workspacePath, normalizedInput);

  const relativeCandidate = path.relative(workspacePath, candidateAbsolute);

  if (
    relativeCandidate.startsWith('..') ||
    path.isAbsolute(relativeCandidate)
  ) {
    throw new ToolError('Path must remain within the workspace');
  }

  const relativePath = relativeCandidate === '' ? '.' : relativeCandidate;

  return {
    workspacePath,
    relativePath,
    absolutePath: candidateAbsolute,
  };
}

/**
 * Convert an absolute path back into a workspace-relative path while enforcing
 * workspace boundaries.
 */
export function toWorkspaceRelativePath(
  workspacePath: string,
  absolutePath: string,
): string {
  const normalizedAbsolute = path.normalize(absolutePath);
  const relative = path.relative(workspacePath, normalizedAbsolute);

  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new ToolError('Resolved path must stay within the workspace');
  }

  return relative === '' ? '.' : relative;
}

/**
 * Normalize workspace-relative paths for display by converting separators to
 * POSIX style and collapsing the workspace root to `.`.
 */
export function normalizeRelativeForOutput(relativePath: string): string {
  if (relativePath === '.' || relativePath === '') {
    return '.';
  }
  return relativePath.split(path.sep).join('/');
}
