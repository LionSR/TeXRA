/**
 * The single predicate that decides whether a model request should be served by
 * the ChatGPT subscription (Codex backend) instead of the normal OpenAI path.
 *
 * Shared by the handler dispatch (ModelFactory) and the picker availability
 * gate (computeModelOptions) so the two never drift. Deliberately synchronous
 * (config + name match only) — the actual "are you signed in" check happens at
 * request time in the handler and in the async availability context, so the
 * conversation-compatibility key can stay sync.
 */
import { ModelProvider, type ModelConfig } from 'llm-zoo';

import {
  codexBackendModelId,
  isCodexSubscriptionEligible,
} from './codexConstants';
import { isPreferCodexSubscription } from './codexPreference';

/**
 * Whether this model, under the current routing context, should go through the
 * ChatGPT subscription. Does NOT check sign-in (callers handle that): true means
 * "the user asked to prefer the subscription and this model can use it".
 */
export function shouldUseCodexSubscription(
  config: ModelConfig,
  useOpenRouter: boolean,
): boolean {
  if (useOpenRouter) return false;
  if (config.provider !== ModelProvider.OPENAI) return false;
  if (config.openRouterOnly) return false;
  if (!isPreferCodexSubscription()) return false;
  // Match the bare id the Codex backend keys on (`gpt-5.5`), not the date-pinned
  // llm-zoo `fullName` (`gpt-5.5-2026-04-23`) — the same derivation dispatch uses.
  return isCodexSubscriptionEligible(codexBackendModelId(config));
}
