/**
 * Settings Schema - Single Source of Truth
 *
 * This module defines the schema for settings that have dropdown options.
 * The options and defaults are defined here (not in package.json or frontend constants)
 * and can be consumed by both backend and frontend.
 *
 * For storage, settings continue to use:
 * - VS Code configuration (getConfig/updateConfig) for settings in package.json
 * - StateManager (globalSM/workspaceSM) for extension state
 *
 * Config paths (for getConfig/updateConfig):
 * - storageMode: 'texra.agentOutputs.storageMode'
 * - sessionRetention: 'texra.toolUse.persistence.ttlHours'
 * - maxRetryAttempts: 'texra.model.retry.maxAttempts'
 * - formatter: 'texra.latex.formatter'
 * - mathMarkup: 'texra.latexdiff.mathMarkup'
 */

import { z } from 'zod';

// =============================================================================
// DROPDOWN OPTIONS SCHEMAS (Single Source of Truth)
// =============================================================================

/**
 * Settings that have dropdown options.
 * The Zod enum defines the valid values; labels map provides display names.
 * Default values are the first enum value unless specified otherwise.
 */

// Storage mode for agent outputs (matches package.json texra.agentOutputs.storageMode)
export const StorageModeSchema = z.enum(['workspace', 'taskRunStorage']);
export type StorageMode = z.infer<typeof StorageModeSchema>;
export const STORAGE_MODE_DEFAULT: StorageMode = 'workspace';

// Session retention in hours (matches package.json texra.toolUse.persistence.ttlHours)
export const SessionRetentionSchema = z.enum(['24', '48', '72', '168']);
export type SessionRetention = z.infer<typeof SessionRetentionSchema>;
export const SESSION_RETENTION_DEFAULT: SessionRetention = '72';

// Max retry attempts (matches package.json texra.model.retry.maxAttempts)
// Note: '0' means manual retry only
export const MaxRetryAttemptsSchema = z.enum(['0', '1', '2', '3', '5']);
export type MaxRetryAttempts = z.infer<typeof MaxRetryAttemptsSchema>;
export const MAX_RETRY_ATTEMPTS_DEFAULT: MaxRetryAttempts = '0';

// LaTeX formatter (matches package.json texra.latex.formatter)
export const FormatterSchema = z.enum(['latexindent', 'tex-fmt', 'none']);
export type Formatter = z.infer<typeof FormatterSchema>;
export const FORMATTER_DEFAULT: Formatter = 'latexindent';

// Math markup granularity for latexdiff (matches package.json texra.latexdiff.mathMarkup)
export const MathMarkupSchema = z.enum(['off', 'whole', 'coarse', 'fine']);
export type MathMarkup = z.infer<typeof MathMarkupSchema>;
export const MATH_MARKUP_DEFAULT: MathMarkup = 'coarse';

// =============================================================================
// HUMAN-READABLE LABELS
// =============================================================================

/**
 * Labels for dropdown options. If not specified, value is used as label.
 */
export const SETTING_LABELS = {
  storageMode: {
    workspace: 'Workspace (beside sources)',
    taskRunStorage: 'Task storage (isolated)',
  } satisfies Record<StorageMode, string>,

  sessionRetention: {
    '24': '24 hours',
    '48': '48 hours',
    '72': '72 hours',
    '168': '1 week',
  } satisfies Record<SessionRetention, string>,

  maxRetryAttempts: {
    '0': 'Manual only',
    '1': '1',
    '2': '2',
    '3': '3',
    '5': '5',
  } satisfies Record<MaxRetryAttempts, string>,

  formatter: {
    latexindent: 'latexindent',
    'tex-fmt': 'tex-fmt',
    none: 'None (disabled)',
  } satisfies Record<Formatter, string>,

  mathMarkup: {
    off: 'Off (no math markup)',
    whole: 'Whole equations',
    coarse: 'Coarse (default)',
    fine: 'Fine (detailed)',
  } satisfies Record<MathMarkup, string>,
} as const;

/**
 * Descriptions for settings (preserved from package.json for UI display).
 */
export const SETTING_DESCRIPTIONS = {
  storageMode:
    "Where agent-generated files are saved. Use 'workspace' to write beside the sources or 'taskRunStorage' to isolate artifacts inside the extension storage.",
  sessionRetention:
    'Maximum age (in hours) to keep saved tool-use sessions before automatic cleanup.',
  maxRetryAttempts:
    'Number of automatic retry attempts before surfacing a manual retry option for model calls. Set to 0 for no automatic retries (manual retry button only).',
  retryBackoffMs:
    'Base backoff delay in milliseconds between retry attempts for model calls.',
  persistSessions: 'Persist tool-use conversations across VS Code restarts.',
  compactionThreshold:
    'Percentage of context window to trigger automatic context management. For OpenAI, triggers conversation compaction. For Anthropic, triggers server-side clearing of tool uses and thinking blocks. Set to 0 to disable.',
  formatter: "LaTeX formatter to use when formatting files ('none' to disable).",
  mathMarkup:
    'Determine granularity of markup in displayed math environments for latexdiff.',
} as const;

// =============================================================================
// OPTION EXTRACTION UTILITIES
// =============================================================================

type SelectOption = { value: string; label: string };

/**
 * Extract options from an array of string values with optional labels.
 */
function createOptions(
  values: readonly string[],
  labels: Record<string, string> | undefined,
): SelectOption[] {
  return [...values].map((value) => ({
    value,
    label: (labels && labels[value]) ?? value,
  }));
}

/**
 * All dropdown options derived from schemas.
 * Use this in frontend to populate select elements.
 */
export const SELECT_OPTIONS = {
  storageMode: createOptions(
    StorageModeSchema.options,
    SETTING_LABELS.storageMode,
  ),
  sessionRetention: createOptions(
    SessionRetentionSchema.options,
    SETTING_LABELS.sessionRetention,
  ),
  maxRetryAttempts: createOptions(
    MaxRetryAttemptsSchema.options,
    SETTING_LABELS.maxRetryAttempts,
  ),
  formatter: createOptions(FormatterSchema.options, SETTING_LABELS.formatter),
  mathMarkup: createOptions(MathMarkupSchema.options, SETTING_LABELS.mathMarkup),
} as const;

export type SelectOptionKey = keyof typeof SELECT_OPTIONS;

/**
 * Get options for a specific setting.
 */
export function getSelectOptions(key: SelectOptionKey): SelectOption[] {
  return SELECT_OPTIONS[key];
}

// =============================================================================
// CONFIG KEY MAPPING
// =============================================================================

/**
 * Maps schema keys to VS Code config paths.
 * Use this to look up the correct config key for a schema setting.
 */
export const CONFIG_KEYS = {
  storageMode: 'texra.agentOutputs.storageMode',
  sessionRetention: 'texra.toolUse.persistence.ttlHours',
  maxRetryAttempts: 'texra.model.retry.maxAttempts',
  formatter: 'texra.latex.formatter',
  mathMarkup: 'texra.latexdiff.mathMarkup',
} as const;

/**
 * Consolidated defaults for all schema-defined settings.
 * Use these when calling getConfig() to ensure consistency.
 */
export const SETTING_DEFAULTS = {
  storageMode: STORAGE_MODE_DEFAULT,
  sessionRetention: SESSION_RETENTION_DEFAULT,
  maxRetryAttempts: MAX_RETRY_ATTEMPTS_DEFAULT,
  formatter: FORMATTER_DEFAULT,
  mathMarkup: MATH_MARKUP_DEFAULT,
} as const;
