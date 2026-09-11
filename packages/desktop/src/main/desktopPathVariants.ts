// Local imports - shared utilities
import { normalizeFilePath, unique } from '@utils/core';

/**
 * Every separator spelling of a sensitive filesystem path — the trimmed raw
 * form, forward-slash, back-slash, and the JSON-encoded doubled back-slash —
 * so redaction matches mixed-separator text and JSON-serialized log entries
 * (#12175). Returns [] for blank input. The root path '/' keeps its single
 * spelling: turning it into '\' would never match real log or crash text.
 */
export function pathSeparatorVariants(path: string): string[] {
  const trimmed = path.trim();
  if (!trimmed) return [];
  const forward = normalizeFilePath(trimmed);
  const backward = forward === '/' ? forward : forward.replaceAll('/', '\\');
  const encoded = backward.replaceAll('\\', '\\\\');
  return unique([trimmed, forward, backward, encoded]);
}
