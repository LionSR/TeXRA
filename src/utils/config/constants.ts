// Local imports - common (direct import to avoid circular dependency via barrel)
import { globalSM, GlobalStateKey } from '@common/state/stateManager';

// Local imports - config utils
import * as logger from '@logger/logUtils';
import { getConfig } from './configUtils';

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

// Length for preview slices of tool output and responses
export const K_SLICE = 200;

// Generic preview lengths for logging and repetition checks
export const MESSAGE_PREVIEW_LENGTH = 50;
export const REPETITION_PREVIEW_LENGTH = 400;
export const REPETITION_DETECTION_THRESHOLD = 1000;

// Time constants
export const SHORT_SLEEP_MS = 50;
export const REFRESH_THRESHOLD_MS = 200;
export const DIFF_REGISTRATION_DELAY_MS = 300;
export const LATEX_VIEWER_OPEN_DELAY_MS = 5000;
export const LATEX_VIEWER_REFRESH_DELAY_MS = 5000;
export const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;

// Debounce delay constants for UI responsiveness
export const DEBOUNCE_WATCHER_MS = 200; // File system watchers (fast response)
export const DEBOUNCE_OPTIONS_MS = 300; // Dropdown options refresh
export const DEBOUNCE_STATE_SAVE_MS = 500; // State persistence (slower, batched)

// Tool-use persistence defaults (internal)
const DEFAULT_TOOL_USE_PERSISTENCE_TTL_HOURS = 336; // 2 weeks
const DEFAULT_TOOL_USE_MEMORY_ENABLED = true;

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

/** Determine whether the memory tool is enabled for tool-use sessions. */
export function getToolUseMemoryEnabled(): boolean {
  return (
    globalSM?.get<boolean>(
      GlobalStateKey.MEMORY_ENABLED,
      DEFAULT_TOOL_USE_MEMORY_ENABLED,
    ) ?? DEFAULT_TOOL_USE_MEMORY_ENABLED
  );
}

/** Set whether the memory tool is enabled for tool-use sessions. */
export async function setToolUseMemoryEnabled(enabled: boolean): Promise<void> {
  await globalSM?.update(GlobalStateKey.MEMORY_ENABLED, enabled);
}

// ---------------------------------------------------------------------------
// Streaming / Endpoint settings (globalSM-backed)
// ---------------------------------------------------------------------------

/** Map from provider string to GlobalStateKey for per-provider streaming. */
const STREAMING_KEY: Record<string, GlobalStateKey> = {
  openai: GlobalStateKey.STREAMING_OPENAI,
  anthropic: GlobalStateKey.STREAMING_ANTHROPIC,
  openrouter: GlobalStateKey.STREAMING_OPENROUTER,
  google: GlobalStateKey.STREAMING_GOOGLE,
  xai: GlobalStateKey.STREAMING_XAI,
  deepseek: GlobalStateKey.STREAMING_DEEPSEEK,
  moonshot: GlobalStateKey.STREAMING_MOONSHOT,
  dashscope: GlobalStateKey.STREAMING_DASHSCOPE,
};

/** Map from provider string to GlobalStateKey for per-provider endpoint. */
const ENDPOINT_KEY: Record<string, GlobalStateKey> = {
  openai: GlobalStateKey.ENDPOINT_OPENAI,
  anthropic: GlobalStateKey.ENDPOINT_ANTHROPIC,
  google: GlobalStateKey.ENDPOINT_GOOGLE,
  deepseek: GlobalStateKey.ENDPOINT_DEEPSEEK,
  xai: GlobalStateKey.ENDPOINT_XAI,
  moonshot: GlobalStateKey.ENDPOINT_MOONSHOT,
  dashscope: GlobalStateKey.ENDPOINT_DASHSCOPE,
};

/** Read the global streaming default. */
export function getGlobalStreaming(): boolean {
  return globalSM?.get<boolean>(GlobalStateKey.STREAMING_GLOBAL, true) ?? true;
}

/** Set the global streaming default. */
export async function setGlobalStreaming(enabled: boolean): Promise<void> {
  await globalSM?.update(GlobalStateKey.STREAMING_GLOBAL, enabled);
}

/** Read per-provider streaming setting, falling back to global default. */
export function getProviderStreaming(provider: string): boolean {
  const key = STREAMING_KEY[provider.toLowerCase()];
  if (!key) return getGlobalStreaming();
  const global = getGlobalStreaming();
  return globalSM?.get<boolean>(key, global) ?? global;
}

/** Set per-provider streaming setting. */
export async function setProviderStreaming(
  provider: string,
  enabled: boolean,
): Promise<void> {
  const key = STREAMING_KEY[provider.toLowerCase()];
  if (key) {
    await globalSM?.update(key, enabled);
  }
}

/** Read per-provider custom endpoint. Returns empty string when unset. */
export function getProviderEndpoint(provider: string): string {
  const key = ENDPOINT_KEY[provider.toLowerCase()];
  if (!key) return '';
  return globalSM?.get<string>(key, '') ?? '';
}

/** Set per-provider custom endpoint. */
export async function setProviderEndpoint(
  provider: string,
  endpoint: string,
): Promise<void> {
  const key = ENDPOINT_KEY[provider.toLowerCase()];
  if (key) {
    await globalSM?.update(key, endpoint);
  }
}

/** Whether the given provider has a configurable custom endpoint. */
export function supportsCustomEndpoint(provider: string): boolean {
  return provider.toLowerCase() in ENDPOINT_KEY;
}

/** Get the maximum number of automatic retry attempts for model calls. */
export function getModelRetryMaxAttempts(): number {
  return getConfig<number>('texra.model.retry.maxAttempts', 1);
}

/** Get the backoff delay in milliseconds between retry attempts. */
export function getModelRetryBackoffMs(): number {
  return getConfig<number>('texra.model.retry.backoffMs', 1000);
}
