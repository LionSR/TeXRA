// Standard library imports
import * as path from 'node:path';

// Local imports - shared schemas
import { Rejected } from '@shared/session/requestErrors';

/**
 * The dropped paths one launcher field takes: every non-null path whose
 * extension that field accepts, deduplicated and in drop order. A drop that
 * attached nothing but rejected something is the user's to hear about, so it
 * is a rejection rather than an empty result.
 */
export function attachDroppedPaths(
  paths: readonly (string | null)[],
  allowedExtensions: readonly string[],
): { paths: string[]; attachedCount: number; rejectedCount: number } {
  const allowed = new Set(
    allowedExtensions.map(normalizeMainViewFileExtension),
  );
  const attached = new Set<string>();
  let rejectedCount = 0;

  for (const filePath of paths) {
    if (!filePath) {
      rejectedCount += 1;
      continue;
    }
    const extension = normalizeMainViewFileExtension(filePath);
    if (!extension || !allowed.has(extension)) {
      rejectedCount += 1;
      continue;
    }
    attached.add(filePath);
  }

  if (attached.size === 0 && rejectedCount > 0) {
    throw new Rejected({
      reason:
        'No dropped files were attached. Use regular files inside this workspace with supported TeXRA extensions.',
    });
  }

  return {
    paths: [...attached],
    attachedCount: attached.size,
    rejectedCount,
  };
}

export function normalizeMainViewFileExtension(filePath: string): string {
  const trimmed = filePath.trim();
  const extension = path.extname(trimmed) || trimmed;
  return extension.toLowerCase().replace(/^\./, '');
}
