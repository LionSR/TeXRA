// Standard library imports
import * as path from 'path';

// Third-party imports
import * as vscode from 'vscode';

// Local imports - common
import { ListingOptionsSchema, type ListingOptions } from '@common/schemas';

/** Normalize backslashes to forward slashes for consistent comparison */
function toForwardSlashes(str: string): string {
  return str.replaceAll('\\', '/');
}

/** Convert forward slashes to platform-native separators */
function toPlatformSeparators(str: string): string {
  return str.replaceAll('/', path.sep);
}

function sanitizeDirectories(directories: string[]): string[] {
  return directories
    .map((dir) => dir.trim())
    .filter((dir) => dir.length > 0)
    .map((dir) =>
      dir.replaceAll('\\', '/').replace(/^\//, '').replace(/\/$/, ''),
    );
}

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

function containsHiddenSegment(relativePath: string): boolean {
  // Split on both separators for cross-platform compatibility
  return relativePath
    .split(/[/\\]/)
    .some((segment) => segment.startsWith('.') && segment.length > 1);
}

/**
 * Get path relative to root, preserving symlink structure within workspace.
 * Uses VS Code's asRelativePath for symlink awareness, then computes
 * the path relative to the specified root.
 *
 * @param absolutePath - The absolute path to convert
 * @param root - The base directory for relative path computation
 * @returns Platform-native relative path
 */
function getRelativePathPreservingSymlinks(
  absolutePath: string,
  root: string,
): string {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  // Use asRelativePath for symlink awareness (returns forward slashes)
  const wsRelative = vscode.workspace.asRelativePath(absolutePath, false);

  // If outside workspace, asRelativePath returns the original absolute path
  if (wsRelative === absolutePath) {
    return path.relative(root, absolutePath);
  }

  // If root is the workspace root, return the workspace-relative path
  if (workspaceRoot && path.normalize(root) === path.normalize(workspaceRoot)) {
    return toPlatformSeparators(wsRelative);
  }

  // root is a subdirectory - compute path from workspace-relative path
  // First get root relative to workspace
  const rootRelative = vscode.workspace.asRelativePath(root, false);
  if (rootRelative === root) {
    // root is outside workspace, fall back to path.relative
    return path.relative(root, absolutePath);
  }

  // Both paths are workspace-relative, compute relative path between them
  const wsRelativeNorm = toForwardSlashes(wsRelative);
  const rootRelativeNorm = toForwardSlashes(rootRelative);

  if (wsRelativeNorm.startsWith(rootRelativeNorm + '/')) {
    // File is under root, strip the root prefix
    const result = wsRelativeNorm.slice(rootRelativeNorm.length + 1);
    return toPlatformSeparators(result);
  }

  // File is not under root in workspace structure, use path.relative
  return path.relative(root, absolutePath);
}

function containsExcludedDirectory(
  relativePath: string,
  normalizedExcludeDirs: string[],
): boolean {
  // Split on both separators for cross-platform compatibility
  const pathSegments = relativePath.split(/[/\\]/).map((s) => s.toLowerCase());
  return pathSegments.some((segment) =>
    normalizedExcludeDirs.includes(segment),
  );
}

interface NormalizedListingOptions {
  includeExt: string[];
  excludeExt: string[];
  excludeKeywords: string[];
  excludeDirs: string[];
  excludeFiles: string[];
  excludePattern?: vscode.RelativePattern;
}

function prepareFilters(
  patternRoot: string,
  options: ListingOptions,
): NormalizedListingOptions {
  // Schema provides defaults for all optional fields
  const parsed = ListingOptionsSchema.parse(options);

  const sanitizedDirectories = sanitizeDirectories(parsed.excludeDirectories);

  return {
    includeExt: parsed.includeExtensions.map((ext) => ext.toLowerCase()),
    excludeExt: parsed.excludeExtensions.map((ext) => ext.toLowerCase()),
    excludeKeywords: parsed.excludeKeywords.map((keyword) =>
      keyword.toLowerCase(),
    ),
    excludeDirs: sanitizedDirectories.map((dir) => dir.toLowerCase()),
    excludeFiles: parsed.excludeFiles.map((file) => file.toLowerCase()),
    excludePattern: createExcludePattern(patternRoot, sanitizedDirectories),
  };
}

/** Check if a filename passes extension and keyword filters */
function passesFileFilters(
  fileNameLower: string,
  filters: NormalizedListingOptions,
): boolean {
  const matchesInclude =
    filters.includeExt.length === 0 ||
    filters.includeExt.some((ext) => fileNameLower.endsWith(ext));
  const matchesExcludeExt = filters.excludeExt.some((ext) =>
    fileNameLower.endsWith(ext),
  );
  const matchesExcludeKeyword = filters.excludeKeywords.some((keyword) =>
    fileNameLower.includes(keyword),
  );
  return matchesInclude && !matchesExcludeExt && !matchesExcludeKeyword;
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
  const filters = prepareFilters(root, {
    includeExtensions,
    excludeExtensions,
    excludeDirectories,
    excludeKeywords,
    excludeFiles,
  });
  const files = await vscode.workspace.findFiles(
    new vscode.RelativePattern(dir, '**/*'),
    filters.excludePattern,
  );

  return files
    .map((uri) => getRelativePathPreservingSymlinks(uri.fsPath, root))
    .filter((relativePath) => {
      if (!relativePath) {
        return false;
      }

      if (containsHiddenSegment(relativePath)) {
        return false;
      }

      // Check if any segment of the path matches an excluded directory
      if (containsExcludedDirectory(relativePath, filters.excludeDirs)) {
        return false;
      }

      const fileNameLower = path.basename(relativePath).toLowerCase();
      if (filters.excludeFiles.includes(fileNameLower)) return false;
      return passesFileFilters(fileNameLower, filters);
    });
}
