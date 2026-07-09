// Local imports - shared utilities
import { getBasename } from '@utils/core';

type LanguageMap =
  ReadonlyMap<string, string> | Readonly<Record<string, string>>;

interface LanguageForPathConfig {
  basenameLanguages: LanguageMap;
  extensionLanguages: LanguageMap;
  fallbackLanguage: string;
  unknownExtensionLanguage?: (extension: string) => string | undefined;
}

export const SPECIAL_BASENAME_LANGUAGES: Readonly<Record<string, string>> = {
  dockerfile: 'dockerfile',
  makefile: 'makefile',
};

function languageFromMap(
  languages: LanguageMap,
  key: string,
): string | undefined {
  if (languages instanceof Map) {
    return languages.get(key);
  }

  const languageRecord = languages as Readonly<Record<string, string>>;
  return Object.hasOwn(languageRecord, key) ? languageRecord[key] : undefined;
}

/**
 * Resolve a language id from shared path parsing with caller-specific language tables.
 */
export function languageForPath(
  filePath: string,
  config: LanguageForPathConfig,
): string {
  if (!filePath) return config.fallbackLanguage;

  const fileName = getBasename(filePath) || filePath;
  const lowerFileName = fileName.toLowerCase();

  const basenameLanguage = languageFromMap(
    config.basenameLanguages,
    lowerFileName,
  );
  if (basenameLanguage) return basenameLanguage;

  const lastDot = fileName.lastIndexOf('.');
  if (lastDot === -1 || lastDot === fileName.length - 1) {
    return config.fallbackLanguage;
  }

  const extension = fileName.slice(lastDot + 1).toLowerCase();
  return (
    languageFromMap(config.extensionLanguages, extension) ??
    config.unknownExtensionLanguage?.(extension) ??
    config.fallbackLanguage
  );
}
