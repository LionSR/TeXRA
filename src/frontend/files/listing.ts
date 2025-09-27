// Standard library imports
import * as path from 'path';

// Third-party imports
import * as vscode from 'vscode';

function createExcludePattern(
  root: string,
  directories: string[],
): vscode.RelativePattern | undefined {
  const sanitized = directories
    .map((dir) => dir.trim())
    .filter((dir) => dir.length > 0)
    .map((dir) =>
      dir.replace(/\\/g, '/').replace(/^\//, '').replace(/\/$/, ''),
    );

  if (sanitized.length === 0) {
    return undefined;
  }

  const globSegments = sanitized.map((dir) => `**/${dir}/**`);
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

export async function getFilesInDirectory(
  dir: string,
  includeExtensions: string[] = [],
  excludeExtensions: string[] = [],
  excludeDirectories: string[] = [],
  excludeKeywords: string[] = [],
): Promise<string[]> {
  const normalizedIncludeExt = includeExtensions.map((e) => e.toLowerCase());
  const normalizedExcludeExt = excludeExtensions.map((e) => e.toLowerCase());
  const normalizedExcludeKeywords = excludeKeywords.map((k) => k.toLowerCase());
  const normalizedExcludeDirs = excludeDirectories.map((d) => d.toLowerCase());
  const excludePattern = createExcludePattern(dir, excludeDirectories);
  const files = await vscode.workspace.findFiles(
    new vscode.RelativePattern(dir, '*'),
    excludePattern,
  );

  return files
    .filter((uri) => {
      // Check if the file is inside an excluded directory (for symlinks, case-insensitive)
      const relativePath = path.relative(dir, uri.fsPath);
      return !containsExcludedDirectory(relativePath, normalizedExcludeDirs);
    })
    .map((uri) => path.basename(uri.fsPath))
    .filter((name) => {
      const nameLower = name.toLowerCase();
      return (
        !name.startsWith('.') &&
        (normalizedIncludeExt.length === 0 ||
          normalizedIncludeExt.some((ext) => nameLower.endsWith(ext))) &&
        !normalizedExcludeExt.some((ext) => nameLower.endsWith(ext)) &&
        !normalizedExcludeKeywords.some((keyword) =>
          nameLower.includes(keyword),
        )
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
  const normalizedIncludeExt = includeExtensions.map((e) => e.toLowerCase());
  const normalizedExcludeExt = excludeExtensions.map((e) => e.toLowerCase());
  const normalizedExcludeKeywords = excludeKeywords.map((k) => k.toLowerCase());
  const normalizedExcludeFiles = excludeFiles.map((f) => f.toLowerCase());
  const normalizedExcludeDirs = excludeDirectories.map((d) => d.toLowerCase());
  const excludePattern = createExcludePattern(root, excludeDirectories);
  const files = await vscode.workspace.findFiles(
    new vscode.RelativePattern(dir, '**/*'),
    excludePattern,
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
      if (containsExcludedDirectory(relativePath, normalizedExcludeDirs)) {
        return false;
      }

      const fileName = path.basename(relativePath);
      const fileNameLower = fileName.toLowerCase();

      return (
        (normalizedIncludeExt.length === 0 ||
          normalizedIncludeExt.some((ext) => fileNameLower.endsWith(ext))) &&
        !normalizedExcludeExt.some((ext) => fileNameLower.endsWith(ext)) &&
        !normalizedExcludeKeywords.some((keyword) =>
          fileNameLower.includes(keyword),
        ) &&
        !normalizedExcludeFiles.includes(fileNameLower)
      );
    });
}
