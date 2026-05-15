import { z } from 'zod';

import { isNonEmptyString } from '@utils/core/stringCore';

const LEGACY_KEYS = [
  'referenceFile',
  'referenceFiles',
  'auxiliaryFile',
  'auxiliaryFiles',
  'inputFile',
  'contextFile',
  'mediaFile',
] as const;

/**
 * Fold legacy single-slot and renamed (reference/auxiliary) file keys into
 * the canonical `*Files` lists. Single-slot values seed `*Files[0]` only
 * when the list is empty so modern writers always win. Runs at the
 * persistence boundary (UI memento, execution KV store, history records);
 * skipped when no legacy keys are present so listing N executions doesn't
 * pay the clone+delete cost N times.
 */
export function migrateLegacyContextFileFields(input: unknown): unknown {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return input;
  }
  const source = input as Record<string, unknown>;
  if (!LEGACY_KEYS.some((key) => key in source)) {
    return input;
  }
  const obj = { ...source };

  // Step 1: rename reference/auxiliary → context.
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

  // Step 2: collapse single-slot fields into *Files lists.
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
 * Used by AgentConfig where `editedFile` may be null. The migration
 * shim is applied at the outer schema (not here) because ZodEffects
 * doesn't compose with `.merge()`/`.extend()`.
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
