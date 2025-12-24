/**
 * Type definitions for server-side API key access.
 */

/**
 * All providers that could potentially support server-side API keys.
 * The actual enabled providers are fetched from the relay server at runtime.
 */
export const SERVER_SIDE_PROVIDERS = [
  'openai',
  'anthropic',
  'google',
  'xai',
  'deepseek',
  'moonshot',
  'dashscope',
] as const;

export type ServerSideProvider = (typeof SERVER_SIDE_PROVIDERS)[number];
