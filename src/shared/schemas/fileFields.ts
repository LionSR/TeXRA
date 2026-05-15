/**
 * File field schemas - single source of truth for file-related config fields.
 *
 * Two variants:
 * - NullableFileFieldsSchema: For storage/config (allows null on `editedFile`)
 * - UIFileFieldsSchema: For UI state (coerces null → '')
 *
 * The single-slot input/context/media fields were collapsed in May 2026:
 * canonical state is now `inputFiles` / `contextFiles` / `mediaFiles` lists,
 * with the "primary" file being `inputFiles[0]` etc. `baseFile` and
 * `editedFile` remain single because they have distinct latexdiff semantics.
 *
 * Both schemas run `migrateLegacyContextFileFields` so persisted records
 * written before the collapse (and before the reference/auxiliary → context
 * rename) keep parsing.
 */
import { z } from 'zod';

import { isNonEmptyString } from '@utils/core/stringCore';

/**
 * Fold pre-collapse single-slot file keys (`inputFile`, `contextFile`,
 * `mediaFile`) into the canonical `*Files` lists, and fold pre-rename
 * `referenceFile{,s}` / `auxiliaryFile{,s}` into the `context` namespace.
 *
 * The single-slot value becomes the head of the `*Files` list when that list
 * is empty; otherwise the existing list wins (modern writers control the
 * head explicitly). Used by every schema that reads persisted file-field
 * state (UI memento, execution KV store, history records).
 */
export function migrateLegacyContextFileFields(input: unknown): unknown {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return input;
  }
  const obj = { ...(input as Record<string, unknown>) };

  // ---- Step 1: rename reference/auxiliary -> context (pre-#4035 records) --
  // Pull the legacy single-slot context value from referenceFile, falling
  // back to auxiliaryFile, before we collapse it into contextFiles below.
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

  // ---- Step 2: collapse single-slot fields into *Files lists -------------
  // For each (single, multi) pair, if the multi list is missing/empty and the
  // single slot has a value, seed the multi list with the single value. Then
  // drop the single key from the canonical shape.
  for (const [single, multi] of [
    ['inputFile', 'inputFiles'],
    ['contextFile', 'contextFiles'],
    ['mediaFile', 'mediaFiles'],
  ] as const) {
    const listValue = obj[multi];
    const list = Array.isArray(listValue)
      ? listValue.filter(isNonEmptyString)
      : [];
    if (list.length === 0 && isNonEmptyString(obj[single])) {
      obj[multi] = [obj[single] as string];
    } else if (Array.isArray(listValue)) {
      obj[multi] = list;
    }
    delete obj[single];
  }

  return obj;
}

/**
 * File fields with nullable single-file fields.
 * Used by AgentConfig where null means "not set" (for editedFile only).
 * Apply `migrateLegacyContextFileFields` via `z.preprocess` at the outer
 * schema that reads persisted records, since this object is composed via
 * `.merge()`/`.extend()` and ZodEffects can't compose that way.
 */
export const NullableFileFieldsSchema = z.object({
  inputFiles: z.array(z.string()).prefault([]),
  contextFiles: z.array(z.string()).prefault([]),
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
  inputFiles: z.array(z.string()).prefault([]),
  contextFiles: z.array(z.string()).prefault([]),
  mediaFiles: z.array(z.string()).prefault([]),
  outputFiles: z.array(z.string()).prefault([]),
  editedFile: nullishString,
});

export type UIFileFields = z.infer<typeof UIFileFieldsSchema>;
