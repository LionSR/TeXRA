import { logWebSearch, type AgentTrace } from '@agent/trace';

import type { WebSearchResult } from '../types/ServerToolTypes';

/**
 * Emits a web-search result to the progress view, gated on
 * `progressViewEnabled`.
 *
 * Shared by `ModelHandler`'s OpenAI-Responses streaming closure and
 * `AnthropicStreamHandler` (a collaborator, not a `ModelHandler` subclass,
 * so it can't reach a protected base method) — previously each re-implemented
 * this same guard privately (#7418).
 */
export function emitServerToolResult(
  logger: AgentTrace,
  progressViewEnabled: boolean,
  result: WebSearchResult,
): void {
  if (progressViewEnabled) {
    logWebSearch(logger, result);
  }
}
