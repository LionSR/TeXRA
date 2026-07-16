/**
 * Live "is this model routing through the ChatGPT subscription right now?"
 * check: the synchronous capability resolver and a current ChatGPT sign-in.
 * Async because it reads the stored session.
 *
 * Single place that pairs the prospective routing predicate with
 * `getUseOpenRouter()`, keeping that config read out of CLI render paths.
 */
import { isCodexSignedIn } from '@auth/codex';
import type { AgentCategory } from '@shared/schemas/agent';
import { getUseOpenRouter } from '@utils/config/providerConfig';

import {
  resolveCodexSubscriptionCapabilities,
  resolveCodexSubscriptionCapabilitiesForAgentCategory,
} from './codexSubscriptionRouting';
import { resolveRuntimeModelConfig } from './runtimeModelRegistry';

/**
 * Whether a request for `modelId` would be served by the ChatGPT subscription
 * right now: the model prefers + is eligible for the subscription AND a session
 * is signed in. When a category is supplied, the tool-use-only preference is
 * applied as it is in ModelFactory. Returns `false` for an unknown model id.
 */
export async function isCodexSubscriptionActive(
  modelId: string,
  agentCategory?: AgentCategory,
): Promise<boolean> {
  const config = await resolveRuntimeModelConfig(modelId);
  if (!config) return false;
  const capabilities =
    agentCategory === undefined
      ? resolveCodexSubscriptionCapabilities(config, getUseOpenRouter())
      : resolveCodexSubscriptionCapabilitiesForAgentCategory(
          config,
          getUseOpenRouter(),
          agentCategory,
        );
  if (!capabilities) {
    return false;
  }
  return isCodexSignedIn();
}
