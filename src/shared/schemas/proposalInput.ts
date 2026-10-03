import { isObject } from '@utils/core';

/**
 * Fold the `extractFigures` / `extractTikz` delegation shorthand into the
 * canonical `toolConfig.autoExtract*` flags. Only a flag the input
 * explicitly carried is set (absent stays undefined so the caller's
 * defaults/prefaults apply).
 */
export function extractionShorthandToolConfig(
  source: Record<string, unknown>,
): Record<string, unknown> {
  const existing = isObject(source.toolConfig) ? source.toolConfig : {};
  const overrides: Record<string, unknown> = { ...existing };
  if (source.extractFigures != null) {
    overrides.autoExtractFigure = Boolean(source.extractFigures);
  }
  if (source.extractTikz != null) {
    overrides.autoExtractTikzFigure = Boolean(source.extractTikz);
  }
  return overrides;
}
