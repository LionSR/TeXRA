// Standard library imports
import * as path from 'path';

// Third-party imports
import * as vscode from 'vscode';

// Local imports
import { normalizeFilePath } from '@shared/utils/path';
import { WorkspaceFS } from '@utils/files';

/** Normalize and clean directory paths for filtering */
function sanitizeDirectories(directories: string[]): string[] {
  return directories
    .map((dir) => dir.trim())
    .filter((dir) => dir.length > 0)
    .map((dir) =>
      dir.replaceAll('\\', '/').replace(/^\//, '').replace(/\/$/, ''),
    );
}

/** Create VS Code exclude pattern from directory list */
function createExcludePattern(
  root: string,
  sanitizedDirectories: string[],
): vscode.RelativePattern | undefined {
  if (sanitizedDirectories.length === 0) {
    return undefined;
  }

  const globSegments = sanitizedDirectories.map((dir) => `**/${dir}/**`);
  const globPattern =
    globSegments.length === 1 ? globSegments[0] : `{${globSegments.join(',')}}`;

  return new vscode.RelativePattern(root, globPattern);
}

/** Check if path contains hidden segments (starting with .) */
function containsHiddenSegment(relativePath: string): boolean {
  return relativePath
    .split(/[/\\]/)
    .some((segment) => segment.startsWith('.') && segment.length > 1);
}

/**
 * Get path relative to root, preserving symlink structure within workspace.
 * Delegates to WorkspaceFS.relativePath() for symlink-aware resolution,
 * then computes the path relative to the specified root.
 *
 * Always returns forward slashes for cross-platform consistency.
 */
function getRelativePathPreservingSymlinks(
  absolutePath: string,
  root: string,
): string {
  // WorkspaceFS.relativePath() handles symlinks via asRelativePath
  // and always returns forward slashes.
  const wsRelative = WorkspaceFS.relativePath(absolutePath);

  // If outside workspace, relativePath returns the absolute path (still absolute)
  if (path.isAbsolute(wsRelative)) {
    return normalizeFilePath(path.relative(root, absolutePath));
  }

  // If root is the workspace root, the workspace-relative path is the answer
  const workspaceRoot = WorkspaceFS.getPath();
  if (workspaceRoot && path.normalize(root) === path.normalize(workspaceRoot)) {
    return wsRelative;
  }

  // root is a subdirectory — get its workspace-relative path too
  const rootRelative = WorkspaceFS.relativePath(root);
  if (path.isAbsolute(rootRelative)) {
    return normalizeFilePath(path.relative(root, absolutePath));
  }

  // Both paths are workspace-relative and forward-slash normalized
  if (wsRelative.startsWith(rootRelative + '/')) {
    return wsRelative.slice(rootRelative.length + 1);
  }

  return normalizeFilePath(path.relative(root, absolutePath));
}

/** Check if path contains an excluded directory segment */
function containsExcludedDirectory(
  relativePath: string,
  excludeDirs: string[],
): boolean {
  const pathSegments = relativePath.split(/[/\\]/).map((s) => s.toLowerCase());
  return pathSegments.some((segment) => excludeDirs.includes(segment));
}

interface FileFilters {
  includeExt: string[];
  excludeExt: string[];
  excludeKeywords: string[];
  excludeDirs: string[];
  excludeFiles: string[];
  excludePattern?: vscode.RelativePattern;
}

/** Prepare normalized filter options from raw input arrays */
function prepareFilters(
  root: string,
  includeExtensions: string[],
  excludeExtensions: string[],
  excludeDirectories: string[],
  excludeKeywords: string[],
  excludeFiles: string[],
): FileFilters {
  const sanitizedDirs = sanitizeDirectories(excludeDirectories);

  return {
    includeExt: includeExtensions.map((ext) => ext.toLowerCase()),
    excludeExt: excludeExtensions.map((ext) => ext.toLowerCase()),
    excludeKeywords: excludeKeywords.map((kw) => kw.toLowerCase()),
    excludeDirs: sanitizedDirs.map((dir) => dir.toLowerCase()),
    excludeFiles: excludeFiles.map((file) => file.toLowerCase()),
    excludePattern: createExcludePattern(root, sanitizedDirs),
  };
}

/** Check if a filename passes extension and keyword filters */
function passesFileFilters(
  fileNameLower: string,
  filters: FileFilters,
): boolean {
  if (
    filters.includeExt.length > 0 &&
    !filters.includeExt.some((ext) => fileNameLower.endsWith(ext))
  ) {
    return false;
  }
  if (filters.excludeExt.some((ext) => fileNameLower.endsWith(ext)))
    return false;
  if (filters.excludeKeywords.some((kw) => fileNameLower.includes(kw)))
    return false;
  return true;
}

export async function getFilesRecursively(
  dir: string,
  root: string,
  includeExtensions: string[] = [],
  excludeExtensions: string[] = [],
  excludeDirectories: string[] = [],
  excludeKeywords: string[] = [],
  excludeFiles: string[] = [],
): Promise<string[]> {
  const filters = prepareFilters(
    root,
    includeExtensions,
    excludeExtensions,
    excludeDirectories,
    excludeKeywords,
    excludeFiles,
  );

  const files = await vscode.workspace.findFiles(
    new vscode.RelativePattern(dir, '**/*'),
    filters.excludePattern,
  );

  return files
    .map((uri) => getRelativePathPreservingSymlinks(uri.fsPath, root))
    .filter((relativePath) => {
      if (!relativePath || containsHiddenSegment(relativePath)) return false;
      if (containsExcludedDirectory(relativePath, filters.excludeDirs))
        return false;

      const fileNameLower = path.basename(relativePath).toLowerCase();
      return (
        !filters.excludeFiles.includes(fileNameLower) &&
        passesFileFilters(fileNameLower, filters)
      );
    });
}
