import { DEFAULT_CORE_SETTINGS } from '@shared/schemas/coreSettings';

import {
  LEGACY_AUXILIARY_KEYWORDS_KEY,
  getIncludedExtensions,
  type ExtensionCategory,
} from './fileTypeUtils';

export type ListableFileType = Exclude<ExtensionCategory, 'audio'>;

export interface FileListSettings {
  ignoredFileExtensions: string[];
  ignoredDirectories: string[];
  ignoredKeywords: string[];
  ignoredInputFiles: string[];
  ignoredInputDirectories: string[];
  ignoredMediaDirs: string[];
  /** Carried forward from the removed `auxiliaryKeywords` setting; folded
   *  into the context branch of getFileListConfig for back-compat. */
  legacyAuxiliaryKeywords: string[];
}

export interface FileListConfig {
  extensions: string[];
  ignoredExtensions: string[];
  ignoredDirs: string[];
  ignoredKeywords: string[];
  ignoredFiles: string[];
}

export interface PreparedFileFilters {
  includeExt: string[];
  excludeExt: string[];
  excludeKeywords: string[];
  excludeDirs: string[];
  excludeFiles: string[];
  sanitizedDirs: string[];
}

type ConfigReader = (key: string, fallback: string[]) => string[];

function normalizePathSeparators(filePath: string): string {
  return filePath.replaceAll('\\', '/');
}

function getPathSegments(filePath: string): string[] {
  return normalizePathSeparators(filePath).split('/');
}

function getPathFileName(filePath: string): string {
  return getPathSegments(filePath).at(-1) ?? '';
}

export function getFileBaseName(filePath: string): string {
  const fileName = getPathFileName(filePath);
  const dotIndex = fileName.lastIndexOf('.');
  return dotIndex > 0 ? fileName.slice(0, dotIndex) : fileName;
}

function normalizeList(values: readonly string[]): string[] {
  return values
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .map((value) => value.toLowerCase());
}

export function loadFileListSettings(
  readConfig: ConfigReader,
): FileListSettings {
  const ignored = DEFAULT_CORE_SETTINGS.files.ignored;
  return {
    ignoredFileExtensions: readConfig(
      'texra.files.ignored.fileExtensions',
      ignored.fileExtensions,
    ),
    ignoredDirectories: readConfig(
      'texra.files.ignored.directories',
      ignored.directories,
    ),
    ignoredKeywords: readConfig(
      'texra.files.ignored.keywords',
      ignored.keywords,
    ),
    ignoredInputFiles: readConfig(
      'texra.files.ignored.inputFiles',
      ignored.inputFiles,
    ),
    ignoredInputDirectories: readConfig(
      'texra.files.ignored.inputDirectories',
      ignored.inputDirectories,
    ),
    ignoredMediaDirs: readConfig(
      'texra.files.ignored.mediaDirectories',
      ignored.mediaDirectories,
    ),
    // Back-compat: the auxiliaryKeywords setting was removed in this PR.
    // Pass an empty fallback so we get [] if unset and the user's
    // pre-rename customization if still set in their settings.json.
    legacyAuxiliaryKeywords: readConfig(LEGACY_AUXILIARY_KEYWORDS_KEY, []),
  };
}

export function getFileListConfig(
  fileType: ListableFileType,
  settings: FileListSettings,
): FileListConfig | null {
  switch (fileType) {
    case 'input':
      return {
        extensions: getIncludedExtensions('input'),
        ignoredExtensions: settings.ignoredFileExtensions,
        ignoredDirs: [
          ...settings.ignoredDirectories,
          ...settings.ignoredInputDirectories,
        ],
        ignoredKeywords: settings.ignoredKeywords,
        ignoredFiles: settings.ignoredInputFiles,
      };
    case 'context':
      return {
        extensions: getIncludedExtensions('context'),
        ignoredExtensions: settings.ignoredFileExtensions,
        ignoredDirs: settings.ignoredDirectories,
        // Concatenate any pre-rename `auxiliaryKeywords` (model-name filters
        // like `o1`/`gpt`/`sonnet`/...) so a user who customized that list
        // keeps their filtering when `.cls`/`.sty` files land in Context.
        ignoredKeywords: [
          ...settings.ignoredKeywords,
          ...settings.legacyAuxiliaryKeywords,
        ],
        ignoredFiles: settings.ignoredInputFiles,
      };
    case 'media':
      return {
        extensions: getIncludedExtensions('media'),
        ignoredExtensions: [],
        ignoredDirs: settings.ignoredMediaDirs,
        ignoredKeywords: settings.ignoredKeywords,
        ignoredFiles: [],
      };
    case 'edited':
      return null;
  }
}

export function getEditedFileListConfig(
  settings: FileListSettings,
): FileListConfig {
  return {
    extensions: getIncludedExtensions('edited'),
    ignoredExtensions: settings.ignoredFileExtensions,
    ignoredDirs: [
      ...settings.ignoredDirectories,
      ...settings.ignoredInputDirectories,
    ],
    ignoredKeywords: settings.ignoredKeywords,
    ignoredFiles: settings.ignoredInputFiles,
  };
}

export function sanitizeDirectories(directories: readonly string[]): string[] {
  return directories
    .map((dir) => dir.trim())
    .filter((dir) => dir.length > 0)
    .map((dir) =>
      normalizePathSeparators(dir).replace(/^\//, '').replace(/\/$/, ''),
    );
}

export function prepareFileFilters(
  config: FileListConfig,
): PreparedFileFilters {
  const sanitizedDirs = sanitizeDirectories(config.ignoredDirs);
  return {
    includeExt: normalizeList(config.extensions),
    excludeExt: normalizeList(config.ignoredExtensions),
    excludeKeywords: normalizeList(config.ignoredKeywords),
    excludeDirs: sanitizedDirs.map((dir) => dir.toLowerCase()),
    excludeFiles: normalizeList(config.ignoredFiles),
    sanitizedDirs,
  };
}

export function containsHiddenSegment(relativePath: string): boolean {
  return getPathSegments(relativePath).some(
    (segment) => segment.startsWith('.') && segment.length > 1,
  );
}

export function containsExcludedDirectory(
  relativePath: string,
  excludeDirs: readonly string[],
): boolean {
  const normalizedPath = normalizePathSeparators(relativePath).toLowerCase();
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
  filters: PreparedFileFilters,
): boolean {
  if (!relativePath || containsHiddenSegment(relativePath)) return false;
  if (containsExcludedDirectory(relativePath, filters.excludeDirs))
    return false;

  const lowerPath = relativePath.toLowerCase();
  const fileNameLower = getPathFileName(lowerPath);
  if (filters.excludeFiles.includes(fileNameLower)) return false;
  if (
    filters.includeExt.length > 0 &&
    !filters.includeExt.some((ext) => lowerPath.endsWith(ext))
  ) {
    return false;
  }
  if (filters.excludeExt.some((ext) => lowerPath.endsWith(ext))) return false;
  if (filters.excludeKeywords.some((kw) => fileNameLower.includes(kw))) {
    return false;
  }
  return true;
}

export function shouldVisitDirectory(
  relativePath: string,
  filters: PreparedFileFilters,
): boolean {
  if (!relativePath) return true;
  if (containsHiddenSegment(relativePath)) return false;
  return !containsExcludedDirectory(relativePath, filters.excludeDirs);
}

export function getBaseNameWithoutRound(baseName: string): string {
  return baseName.match(/^(.+?)(?:_r\d+)?$/)?.[1] ?? baseName;
}

export function matchesEditedFile(
  filePath: string,
  baseFileName: string,
): boolean {
  const baseName = getFileBaseName(baseFileName);
  const fileBase = getFileBaseName(filePath);
  if (fileBase === baseName) return false;
  const baseNameWithoutRound = getBaseNameWithoutRound(baseName);
  return (
    fileBase.startsWith(baseName) ||
    (fileBase.startsWith(baseNameWithoutRound) && /_r\d+/.test(fileBase))
  );
}
