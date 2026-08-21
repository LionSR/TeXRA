// Local imports - shared utilities
import { normalizeFilePath, unique } from '@utils/core';

/**
 * Every separator spelling of a sensitive filesystem path — the trimmed raw
 * form, forward-slash, and back-slash — so redaction matches mixed-separator
 * text. Returns [] for blank input. The root path '/' keeps its single
 * spelling: turning it into '\' would never match real log or crash text.
 */
export function pathSeparatorVariants(path: string): string[] {
  const trimmed = path.trim();
  if (!trimmed) return [];
  const forward = normalizeFilePath(trimmed);
  const backward = forward === '/' ? forward : forward.replaceAll('/', '\\');
  return unique([trimmed, forward, backward]);
}
