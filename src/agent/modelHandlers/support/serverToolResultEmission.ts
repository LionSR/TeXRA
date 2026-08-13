import { logWebSearch, type AgentTrace } from '@agent/trace';
import type { WebSearchResult } from '@agent/types/ServerTools';

/**
 * Emits a web search result to the progress view during streaming, gated on
 * whether the progress view is enabled.
 *
 * Shared by the OpenAI-Responses handler (at its stream-processor deps
 * construction site) and `AnthropicStreamHandler`'s private method — the
 * latter can't reach a handler-protected helper, so both route through this
 * free function instead of re-implementing the guard.
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
