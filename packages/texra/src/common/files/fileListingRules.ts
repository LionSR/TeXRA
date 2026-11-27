import { getBasename, normalizeFilePath } from '@texra-ai/worldline/schemas';
import { FILE_HANDLING_RULES } from '@texra/common/files/fileHandlingRules';
import { getIncludedExtensions } from '@texra/common/files/fileTypeUtils';
import type { DocumentFileType } from '@texra/shared/launcher/fileTypes';

/**
 * One include/exclude file-filter shape, shared verbatim from category
 * selection through to normalization — `prepareFileFilters` fills these same
 * fields in place rather than renaming them.
 */
export interface FileFilterConfig {
  include: string[];
  excludeExtensions: string[];
  excludeDirs: string[];
  excludeKeywords: string[];
  excludeFiles: string[];
}

function normalizeList(values: readonly string[]): string[] {
  return values
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.length > 0);
}

const { ignored } = FILE_HANDLING_RULES;

/** The files a text field of the launch form lists. */
export function getFileListConfig(
  fileType: Exclude<DocumentFileType, 'media'>,
): FileFilterConfig {
  return {
    include: getIncludedExtensions(fileType),
    excludeExtensions: [...ignored.fileExtensions],
    excludeDirs: [...ignored.directories],
    excludeKeywords: [...ignored.keywords],
    excludeFiles: [...ignored.inputFiles],
  };
}

export function prepareFileFilters(config: FileFilterConfig): FileFilterConfig {
  return {
    include: normalizeList(config.include),
    excludeExtensions: normalizeList(config.excludeExtensions),
    excludeKeywords: normalizeList(config.excludeKeywords),
    excludeDirs: normalizeList(config.excludeDirs).map((dir) =>
      normalizeFilePath(dir).replace(/^\//, '').replace(/\/$/, ''),
    ),
    excludeFiles: normalizeList(config.excludeFiles),
  };
}

function containsHiddenSegment(relativePath: string): boolean {
  return normalizeFilePath(relativePath)
    .split('/')
    .some((segment) => segment.startsWith('.') && segment.length > 1);
}

function containsExcludedDirectory(
  relativePath: string,
  excludeDirs: readonly string[],
): boolean {
  const normalizedPath = normalizeFilePath(relativePath).toLowerCase();
  const pathSegments = normalizedPath.split('/');

  return excludeDirs.some((dir) => {
    if (dir.includes('/')) {
      return `/${normalizedPath}/`.includes(`/${dir}/`);
    }
    return pathSegments.includes(dir);
  });
}

export function passesFileFilters(
  relativePath: string,
  filters: FileFilterConfig,
): boolean {
  if (!relativePath || containsHiddenSegment(relativePath)) return false;
  if (containsExcludedDirectory(relativePath, filters.excludeDirs))
    return false;

  const lowerPath = relativePath.toLowerCase();
  const fileNameLower = getBasename(lowerPath);
  if (filters.excludeFiles.includes(fileNameLower)) return false;
  if (
    filters.include.length > 0 &&
    !filters.include.some((ext) => lowerPath.endsWith(ext))
  ) {
    return false;
  }
  if (filters.excludeExtensions.some((ext) => lowerPath.endsWith(ext)))
    return false;
  if (filters.excludeKeywords.some((kw) => fileNameLower.includes(kw))) {
    return false;
  }
  return true;
}

export function shouldVisitDirectory(
  relativePath: string,
  filters: FileFilterConfig,
): boolean {
  if (!relativePath) return true;
  if (containsHiddenSegment(relativePath)) return false;
  return !containsExcludedDirectory(relativePath, filters.excludeDirs);
}
