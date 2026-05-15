/**
 * File field schemas - single source of truth for file-related config fields.
 *
 * Two variants:
 * - NullableFileFieldsSchema: For storage/config (allows null)
 * - UIFileFieldsSchema: For UI state (coerces null → '')
 *
 * Both run `migrateLegacyContextFileFields` so persisted records written
 * before the reference/auxiliary → context rename keep parsing.
 */
import { z } from 'zod';

import { isNonEmptyString } from '@utils/core/stringCore';

/**
 * Fold pre-rename `referenceFile`/`referenceFiles`/`auxiliaryFile`/
 * `auxiliaryFiles` keys into the canonical `contextFile`/`contextFiles`
 * shape. New keys win when both are present. Used by every schema that
 * reads persisted file-field state (UI memento, execution KV store).
 */
export function migrateLegacyContextFileFields(input: unknown): unknown {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return input;
  }
  const obj = { ...(input as Record<string, unknown>) };

  if (obj.contextFile === undefined || obj.contextFile === null) {
    if (isNonEmptyString(obj.referenceFile)) {
      obj.contextFile = obj.referenceFile;
    } else if (isNonEmptyString(obj.auxiliaryFile)) {
      obj.contextFile = obj.auxiliaryFile;
    }
  }

  if (obj.contextFiles === undefined) {
    const refList = Array.isArray(obj.referenceFiles) ? obj.referenceFiles : [];
    const auxList = Array.isArray(obj.auxiliaryFiles) ? obj.auxiliaryFiles : [];
    // Fold an unclaimed auxiliary single slot into the multi list so it
    // isn't dropped when reference already took the contextFile spot.
    const auxFallback =
      isNonEmptyString(obj.auxiliaryFile) &&
      obj.contextFile !== obj.auxiliaryFile
        ? [obj.auxiliaryFile]
        : [];
    const merged = [
      ...new Set(
        [...refList, ...auxList, ...auxFallback].filter(isNonEmptyString),
      ),
    ];
    if (merged.length > 0) obj.contextFiles = merged;
  }

  delete obj.referenceFile;
  delete obj.referenceFiles;
  delete obj.auxiliaryFile;
  delete obj.auxiliaryFiles;

  return obj;
}

/**
 * File fields with nullable single-file fields.
 * Used by AgentConfig where null means "not set". Apply
 * `migrateLegacyContextFileFields` via `z.preprocess` at the outer
 * schema that reads persisted records, since this object is composed via
 * `.merge()`/`.extend()` and ZodEffects can't compose that way.
 */
export const NullableFileFieldsSchema = z.object({
  inputFile: z.string().prefault(''),
  inputFiles: z.array(z.string()).prefault([]),
  contextFile: z.string().nullable().prefault(null),
  contextFiles: z.array(z.string()).prefault([]),
  mediaFile: z.string().nullable().prefault(null),
  mediaFiles: z.array(z.string()).prefault([]),
  outputFiles: z.array(z.string()).prefault([]),
  editedFile: z.string().nullable().prefault(null),
});

export type NullableFileFields = z.infer<typeof NullableFileFieldsSchema>;

/** Schema that accepts string or null/undefined, outputs string (coerces nullish → ''). */
const nullishString = z
  .string()
  .nullish()
  .transform((v) => v ?? '');

/**
 * File fields for UI state where null is not valid.
 * Uses transform to coerce null/undefined → ''.
 */
export const UIFileFieldsSchema = z.object({
  inputFile: z.string().prefault(''),
  inputFiles: z.array(z.string()).prefault([]),
  contextFile: nullishString,
  contextFiles: z.array(z.string()).prefault([]),
  mediaFile: nullishString,
  mediaFiles: z.array(z.string()).prefault([]),
  outputFiles: z.array(z.string()).prefault([]),
  editedFile: nullishString,
});

export type UIFileFields = z.infer<typeof UIFileFieldsSchema>;
