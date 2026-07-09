// Standard library imports
import * as path from 'node:path';

// Third-party imports
import * as vscode from 'vscode';

// Local imports
import {
  passesFileFilters,
  prepareFileFilters,
  type PreparedFileFilters,
} from '@common/files/fileListingRules';
import { normalizeFilePath } from '@utils/core';
import { WorkspaceFS } from '@utils/files';

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

interface VSCodeFileFilters extends PreparedFileFilters {
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
): VSCodeFileFilters {
  const filters = prepareFileFilters({
    extensions: includeExtensions,
    ignoredExtensions: excludeExtensions,
    ignoredDirs: excludeDirectories,
    ignoredKeywords: excludeKeywords,
    ignoredFiles: excludeFiles,
  });

  return {
    ...filters,
    excludePattern: createExcludePattern(root, filters.sanitizedDirs),
  };
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
    .filter((relativePath) => passesFileFilters(relativePath, filters));
}
