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

async function filterToFilesAndSymlinks(
  uris: vscode.Uri[],
): Promise<vscode.Uri[]> {
  const entries = await Promise.all(
    uris.map(async (uri) => {
      try {
        const stat = await vscode.workspace.fs.stat(uri);
        const isFile = (stat.type & vscode.FileType.File) !== 0;
        const isSymbolicLink = (stat.type & vscode.FileType.SymbolicLink) !== 0;

        if (isFile || isSymbolicLink) {
          return uri;
        }
      } catch {
        // Ignore files that disappear between the search and stat checks.
      }

      return null;
    }),
  );

  return entries.filter((uri): uri is vscode.Uri => uri !== null);
}

function containsHiddenSegment(relativePath: string): boolean {
  return relativePath
    .split(path.sep)
    .some((segment) => segment.startsWith('.') && segment.length > 1);
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
  const excludePattern = createExcludePattern(dir, excludeDirectories);
  const files = await vscode.workspace.findFiles(
    new vscode.RelativePattern(dir, '*'),
    excludePattern,
  );
  const filteredFiles = await filterToFilesAndSymlinks(files);

  return filteredFiles
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
  const excludePattern = createExcludePattern(dir, excludeDirectories);
  const files = await vscode.workspace.findFiles(
    new vscode.RelativePattern(dir, '**/*'),
    excludePattern,
  );
  const filteredFiles = await filterToFilesAndSymlinks(files);

  return filteredFiles
    .map((uri) => path.relative(root, uri.fsPath))
    .filter((relativePath) => {
      if (
        !relativePath ||
        relativePath === '.' ||
        relativePath.startsWith('..')
      ) {
        return false;
      }

      if (containsHiddenSegment(relativePath)) {
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
