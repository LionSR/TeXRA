import { DEFAULT_TEXRA_SETTINGS } from '@shared/schemas/settingsConfiguration';

import {
  getDefaultIncludedExtensions,
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
  ignoredAuxKeywords: string[];
  ignoredMediaDirs: string[];
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

function getConfiguredIncludedExtensions(
  category: ExtensionCategory,
): string[] {
  return getIncludedExtensions(
    category,
    getDefaultIncludedExtensions(category),
  );
}

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
  const ignored = DEFAULT_TEXRA_SETTINGS.files.ignored;
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
    ignoredAuxKeywords: readConfig(
      'texra.files.ignored.auxiliaryKeywords',
      ignored.auxiliaryKeywords,
    ),
    ignoredMediaDirs: readConfig(
      'texra.files.ignored.mediaDirectories',
      ignored.mediaDirectories,
    ),
  };
}

export function getFileListConfig(
  fileType: ListableFileType,
  settings: FileListSettings,
): FileListConfig | null {
  switch (fileType) {
    case 'input':
      return {
        extensions: getConfiguredIncludedExtensions('input'),
        ignoredExtensions: settings.ignoredFileExtensions,
        ignoredDirs: [
          ...settings.ignoredDirectories,
          ...settings.ignoredInputDirectories,
        ],
        ignoredKeywords: settings.ignoredKeywords,
        ignoredFiles: settings.ignoredInputFiles,
      };
    case 'reference':
      return {
        extensions: getConfiguredIncludedExtensions('reference'),
        ignoredExtensions: settings.ignoredFileExtensions,
        ignoredDirs: settings.ignoredDirectories,
        ignoredKeywords: settings.ignoredKeywords,
        ignoredFiles: settings.ignoredInputFiles,
      };
    case 'auxiliary':
      return {
        extensions: getConfiguredIncludedExtensions('auxiliary'),
        ignoredExtensions: settings.ignoredFileExtensions,
        ignoredDirs: settings.ignoredDirectories,
        ignoredKeywords: [
          ...settings.ignoredKeywords,
          ...settings.ignoredAuxKeywords,
        ],
        ignoredFiles: [],
      };
    case 'media':
      return {
        extensions: getConfiguredIncludedExtensions('media'),
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
    extensions: getConfiguredIncludedExtensions('edited'),
    ignoredExtensions: settings.ignoredFileExtensions,
    ignoredDirs: [
      ...settings.ignoredDirectories,
      ...settings.ignoredInputDirectories,
    ],
    ignoredKeywords: settings.ignoredKeywords,
    ignoredFiles: settings.ignoredInputFiles,
  };
}

export function getFilterExtensions(fileType: ListableFileType): string[] {
  return getConfiguredIncludedExtensions(fileType).map((ext) =>
    ext.replace(/^\./, ''),
  );
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
  if (filters.excludeKeywords.some((kw) => lowerPath.includes(kw))) {
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
