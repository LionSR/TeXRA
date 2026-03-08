// Local imports - config utils
import * as logger from '@logger/logUtils';
import { getConfig } from './configUtils';

// Re-export pure (platform-agnostic) constants so existing barrel consumers
// keep working without changes. VS Code-free zones should import directly
// from '@utils/config/pureConstants' instead.
export {
  K_SLICE,
  MESSAGE_PREVIEW_LENGTH,
  REPETITION_PREVIEW_LENGTH,
  REPETITION_DETECTION_THRESHOLD,
  SHORT_SLEEP_MS,
  REFRESH_THRESHOLD_MS,
  THREE_DAYS_MS,
  DEBOUNCE_WATCHER_MS,
  DEBOUNCE_OPTIONS_MS,
  DEBOUNCE_STATE_SAVE_MS,
  FILE_TYPES,
  type FileType,
} from './pureConstants';

const CHANNEL = 'config';

// Settings query constants for VS Code settings UI
export const SETTINGS_QUERY = {
  EXTENSION: '@ext:texra-ai.texra',
  MODELS: '@ext:texra-ai.texra models',
} as const;

// Tool-use persistence defaults (internal)
const DEFAULT_TOOL_USE_PERSISTENCE_TTL_HOURS = 336; // 2 weeks

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
    logger.warn(
      CHANNEL,
      `Invalid tool-use persistence TTL value: ${value}. Using default of ${DEFAULT_TOOL_USE_PERSISTENCE_TTL_HOURS} hours.`,
    );
    return DEFAULT_TOOL_USE_PERSISTENCE_TTL_HOURS;
  }
  return hours;
}

// Re-export memory functions from providerConfig (single source of truth via stateBridge)
export { getToolUseMemoryEnabled, setToolUseMemoryEnabled } from './providerConfig';

/** Get the maximum number of automatic retry attempts for model calls. */
export function getModelRetryMaxAttempts(): number {
  return getConfig<number>('texra.model.retry.maxAttempts', 1);
}

/** Get the backoff delay in milliseconds between retry attempts. */
export function getModelRetryBackoffMs(): number {
  return getConfig<number>('texra.model.retry.backoffMs', 1000);
}
