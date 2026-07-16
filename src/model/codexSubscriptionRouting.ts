/**
 * The single route/profile resolver that decides whether a model request should
 * be served by the ChatGPT subscription (Codex backend) instead of the normal
 * OpenAI path.
 *
 * Shared by the handler dispatch (ModelFactory) and the picker availability
 * gate (computeModelOptions) so the two never drift. Deliberately synchronous
 * (config + name match only) - the actual "are you signed in" check happens at
 * request time in the handler and in the async availability context, so the
 * conversation-compatibility key can stay sync.
 */

import {
  isCodexSubscriptionToolUseOnly,
  isPreferCodexSubscription,
} from '@auth/codex';
import { AgentCategory } from '@shared/schemas/agent';

import {
  resolveProviderCapabilities,
  type ProviderCapabilityProfile,
} from './providerCapabilities';
import type { ModelConfig } from 'llm-zoo';

export function resolveCodexSubscriptionCapabilities(
  config: ModelConfig,
  useOpenRouter: boolean,
): ProviderCapabilityProfile | null {
  if (!isPreferCodexSubscription()) return null;
  return resolveProviderCapabilities({
    model: config,
    useOpenRouter,
  });
}

export function resolveCodexSubscriptionCapabilitiesForAgentCategory(
  config: ModelConfig,
  useOpenRouter: boolean,
  agentCategory: AgentCategory | undefined,
): ProviderCapabilityProfile | null {
  const capabilities = resolveCodexSubscriptionCapabilities(
    config,
    useOpenRouter,
  );
  if (!capabilities) return null;
  if (!isCodexSubscriptionToolUseOnly()) return capabilities;
  return agentCategory === AgentCategory.ToolUse ? capabilities : null;
}
