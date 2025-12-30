// Local imports - config utils
import { getConfig } from './configUtils';
import * as logger from '@logger/logUtils';

const CHANNEL = 'config';

// Settings query constants for VS Code settings UI
export const SETTINGS_QUERY = {
  EXTENSION: '@ext:texra-ai.texra',
  WORKFLOW_AGENTS: '@ext:texra-ai.texra texra.agents',
  TOOL_USE_AGENTS: '@ext:texra-ai.texra texra.toolUseAgents',
  MODELS: '@ext:texra-ai.texra models',
  AGENT_DIRECTORY: '@ext:texra-ai.texra explorer.agentsDirectory',
} as const;

// Common file type constants
export const FILE_TYPES = [
  'input',
  'reference',
  'auxiliary',
  'media',
  'output',
] as const;

export type FileType = (typeof FILE_TYPES)[number];
export const SINGLE_FILE_FIELDS = FILE_TYPES.map((type) => `${type}File`);
export const MULTIPLE_FILE_FIELDS = FILE_TYPES.map((type) => `${type}Files`);
export const ACTIVE_FLAGS = FILE_TYPES.map((type) => `${type}FilesActive`);

// Checkbox configuration fields
export const AUTO_EXTRACT_FIELDS = [
  'autoExtractFigure',
  'autoExtractTikzFigure',
  'autoCompileInputPdf',
] as const;
export const TOOL_CONFIG_FIELDS = [
  'attachTeXCount',
  'attachDiagnostics',
] as const;

// Length for preview slices of tool output and responses
export const K_SLICE = 200;

// Generic preview lengths for logging and repetition checks
export const MESSAGE_PREVIEW_LENGTH = 50;
export const REPETITION_PREVIEW_LENGTH = 400;
export const REPETITION_DETECTION_THRESHOLD = 1000;

// for file preview
export const MAX_PREVIEW_LENGTH = 1000;

// Time constants
export const SHORT_SLEEP_MS = 50;
export const REFRESH_THRESHOLD_MS = 200;
export const DIFF_EDITOR_DELAY_MS = 100;
export const WORD_WRAP_INIT_DELAY_MS = 200;
export const DIFF_REGISTRATION_DELAY_MS = 300;
export const LATEX_VIEWER_OPEN_DELAY_MS = 5000;
export const LATEX_VIEWER_REFRESH_DELAY_MS = 5000;
export const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;

// Debounce delay constants for UI responsiveness
export const DEBOUNCE_WATCHER_MS = 200; // File system watchers (fast response)
export const DEBOUNCE_OPTIONS_MS = 300; // Dropdown options refresh
export const DEBOUNCE_STATE_SAVE_MS = 500; // State persistence (slower, batched)

// Tool-use persistence defaults
export const DEFAULT_TOOL_USE_PERSISTENCE_TTL_HOURS = 72;

// Retry defaults
// Default to 0 automatic retries - users must click retry button
export const DEFAULT_MODEL_RETRY_MAX_ATTEMPTS = 0;
export const DEFAULT_MODEL_RETRY_BACKOFF_MS = 1000;

/** Determine whether tool-use session persistence is enabled. */
export function getToolUsePersistenceEnabled(): boolean {
  return getConfig<boolean>('texra.toolUse.persistence.enabled', true);
}

/** Resolve the configured TTL (in hours) for persisted tool-use sessions. */
export function getToolUsePersistenceTtlHours(): number {
  const value = getConfig<number>(
    'texra.toolUse.persistence.ttlHours',
    DEFAULT_TOOL_USE_PERSISTENCE_TTL_HOURS,
  );
  const hours = Number(value);
  if (!Number.isFinite(hours) || hours < 1) {
    // Log a warning when invalid configuration is detected
    logger.warn(
      CHANNEL,
      `Invalid tool-use persistence TTL value: ${value}. Using default of ${DEFAULT_TOOL_USE_PERSISTENCE_TTL_HOURS} hours.`,
    );
    return DEFAULT_TOOL_USE_PERSISTENCE_TTL_HOURS;
  }
  return hours;
}

export function getModelRetryMaxAttempts(): number {
  return getConfig<number>(
    'texra.model.retry.maxAttempts',
    DEFAULT_MODEL_RETRY_MAX_ATTEMPTS,
  );
}

export function getModelRetryBackoffMs(): number {
  return getConfig<number>(
    'texra.model.retry.backoffMs',
    DEFAULT_MODEL_RETRY_BACKOFF_MS,
  );
}
