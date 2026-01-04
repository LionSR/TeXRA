// Standard library imports
import * as path from 'path';

// Third-party imports
import * as vscode from 'vscode';

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
  return relativePath
    .split(path.sep)
    .some((segment) => segment.startsWith('.') && segment.length > 1);
}

function containsExcludedDirectory(
  relativePath: string,
  normalizedExcludeDirs: string[],
): boolean {
  const pathSegments = relativePath.split(path.sep).map((s) => s.toLowerCase());
  return pathSegments.some((segment) =>
    normalizedExcludeDirs.includes(segment),
  );
}

interface ListingOptions {
  includeExtensions?: string[];
  excludeExtensions?: string[];
  excludeDirectories?: string[];
  excludeKeywords?: string[];
  excludeFiles?: string[];
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
  const includeExtensions = options.includeExtensions ?? [];
  const excludeExtensions = options.excludeExtensions ?? [];
  const excludeDirectories = options.excludeDirectories ?? [];
  const excludeKeywords = options.excludeKeywords ?? [];
  const excludeFiles = options.excludeFiles ?? [];

  const sanitizedDirectories = sanitizeDirectories(excludeDirectories);

  return {
    includeExt: includeExtensions.map((ext) => ext.toLowerCase()),
    excludeExt: excludeExtensions.map((ext) => ext.toLowerCase()),
    excludeKeywords: excludeKeywords.map((keyword) => keyword.toLowerCase()),
    excludeDirs: sanitizedDirectories.map((dir) => dir.toLowerCase()),
    excludeFiles: excludeFiles.map((file) => file.toLowerCase()),
    excludePattern: createExcludePattern(patternRoot, sanitizedDirectories),
  };
}

export async function getFilesInDirectory(
  dir: string,
  includeExtensions: string[] = [],
  excludeExtensions: string[] = [],
  excludeDirectories: string[] = [],
  excludeKeywords: string[] = [],
): Promise<string[]> {
  const filters = prepareFilters(dir, {
    includeExtensions,
    excludeExtensions,
    excludeDirectories,
    excludeKeywords,
  });
  const files = await vscode.workspace.findFiles(
    new vscode.RelativePattern(dir, '*'),
    filters.excludePattern,
  );

  return files
    .filter((uri) => {
      // Check if the file is inside an excluded directory (for symlinks, case-insensitive)
      const relativePath = path.relative(dir, uri.fsPath);
      return !containsExcludedDirectory(relativePath, filters.excludeDirs);
    })
    .map((uri) => path.basename(uri.fsPath))
    .filter((name) => {
      const nameLower = name.toLowerCase();
      return (
        !name.startsWith('.') &&
        (filters.includeExt.length === 0 ||
          filters.includeExt.some((ext) => nameLower.endsWith(ext))) &&
        !filters.excludeExt.some((ext) => nameLower.endsWith(ext)) &&
        !filters.excludeKeywords.some((keyword) => nameLower.includes(keyword))
      );
    });
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
    .map((uri) => path.relative(root, uri.fsPath))
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

      const fileName = path.basename(relativePath);
      const fileNameLower = fileName.toLowerCase();

      return (
        (filters.includeExt.length === 0 ||
          filters.includeExt.some((ext) => fileNameLower.endsWith(ext))) &&
        !filters.excludeExt.some((ext) => fileNameLower.endsWith(ext)) &&
        !filters.excludeKeywords.some((keyword) =>
          fileNameLower.includes(keyword),
        ) &&
        !filters.excludeFiles.includes(fileNameLower)
      );
    });
}
