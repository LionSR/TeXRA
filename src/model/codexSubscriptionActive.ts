/**
 * Live "is this model routing through the ChatGPT subscription right now?"
 * check: the synchronous capability resolver and a current ChatGPT sign-in.
 * Async because it reads the stored session.
 *
 * Shared by the CLI status bar badge and the `/status` text command so the two
 * never disagree, and the single place that pairs the routing predicate with
 * `getUseOpenRouter()` - keeping that config read out of the CLI render path.
 */
import { isCodexSignedIn } from '@auth/codex';
import { getUseOpenRouter } from '@utils/config/providerConfig';

import { resolveCodexSubscriptionCapabilities } from './codexSubscriptionRouting';
import { resolveRuntimeModelConfig } from './runtimeModelRegistry';

/**
 * Whether a request for `modelId` would be served by the ChatGPT subscription
 * right now: the model prefers + is eligible for the subscription AND a session
 * is signed in. Returns `false` for an unknown model id.
 */
export async function isCodexSubscriptionActive(
  modelId: string,
): Promise<boolean> {
  const config = await resolveRuntimeModelConfig(modelId);
  if (!config) return false;
  if (!resolveCodexSubscriptionCapabilities(config, getUseOpenRouter())) {
    return false;
  }
  return isCodexSignedIn();
}
