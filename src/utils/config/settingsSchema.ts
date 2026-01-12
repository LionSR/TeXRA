/**
 * Settings Schema - Single Source of Truth
 *
 * This module defines the schema for settings that have dropdown options.
 * The options are defined here (not in package.json or frontend constants)
 * and can be consumed by both backend and frontend.
 *
 * For storage, settings continue to use:
 * - VS Code configuration (getConfig/updateConfig) for settings in package.json
 * - StateManager (globalSM/workspaceSM) for extension state
 */

import { z } from 'zod';

// =============================================================================
// DROPDOWN OPTIONS SCHEMAS (Single Source of Truth)
// =============================================================================

/**
 * Settings that have dropdown options.
 * The Zod enum defines the valid values; labels map provides display names.
 */

export const StorageModeSchema = z.enum(['in-place', 'folder']);
export type StorageMode = z.infer<typeof StorageModeSchema>;

export const SessionRetentionSchema = z.enum(['24', '48', '72', '168']);
export type SessionRetention = z.infer<typeof SessionRetentionSchema>;

export const MaxRetryAttemptsSchema = z.enum(['1', '2', '3', '5']);
export type MaxRetryAttempts = z.infer<typeof MaxRetryAttemptsSchema>;

export const FormatterSchema = z.enum(['latexindent', 'tex-fmt', 'none']);
export type Formatter = z.infer<typeof FormatterSchema>;

export const MathMarkupSchema = z.enum(['off', 'whole', 'coarse', 'fine']);
export type MathMarkup = z.infer<typeof MathMarkupSchema>;

// =============================================================================
// HUMAN-READABLE LABELS
// =============================================================================

/**
 * Labels for dropdown options. If not specified, value is used as label.
 */
export const SETTING_LABELS = {
  storageMode: {
    'in-place': 'In-place (overwrite)',
    folder: 'Folder (texra-outputs/)',
  } satisfies Record<StorageMode, string>,

  sessionRetention: {
    '24': '24 hours',
    '48': '48 hours',
    '72': '72 hours',
    '168': '1 week',
  } satisfies Record<SessionRetention, string>,

  maxRetryAttempts: {
    '1': '1',
    '2': '2',
    '3': '3',
    '5': '5',
  } satisfies Record<MaxRetryAttempts, string>,

  formatter: {
    latexindent: 'latexindent',
    'tex-fmt': 'tex-fmt',
    none: 'none',
  } satisfies Record<Formatter, string>,

  mathMarkup: {
    off: 'off',
    whole: 'whole',
    coarse: 'coarse',
    fine: 'fine',
  } satisfies Record<MathMarkup, string>,
} as const;

// =============================================================================
// OPTION EXTRACTION UTILITIES
// =============================================================================

type SelectOption = { value: string; label: string };

/**
 * Extract options from a Zod enum schema.
 */
function extractEnumOptions<T extends z.ZodEnum<[string, ...string[]]>>(
  schema: T,
  labels?: Record<string, string>,
): SelectOption[] {
  return schema.options.map((value) => ({
    value,
    label: labels?.[value] ?? value,
  }));
}

/**
 * All dropdown options derived from schemas.
 * Use this in frontend to populate select elements.
 */
export const SELECT_OPTIONS = {
  storageMode: extractEnumOptions(
    StorageModeSchema,
    SETTING_LABELS.storageMode,
  ),
  sessionRetention: extractEnumOptions(
    SessionRetentionSchema,
    SETTING_LABELS.sessionRetention,
  ),
  maxRetryAttempts: extractEnumOptions(
    MaxRetryAttemptsSchema,
    SETTING_LABELS.maxRetryAttempts,
  ),
  formatter: extractEnumOptions(FormatterSchema, SETTING_LABELS.formatter),
  mathMarkup: extractEnumOptions(MathMarkupSchema, SETTING_LABELS.mathMarkup),
} as const;

export type SelectOptionKey = keyof typeof SELECT_OPTIONS;

/**
 * Get options for a specific setting.
 */
export function getSelectOptions(key: SelectOptionKey): SelectOption[] {
  return SELECT_OPTIONS[key];
}
