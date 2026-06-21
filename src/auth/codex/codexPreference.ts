/**
 * The "prefer my ChatGPT subscription" switch.
 *
 * Off by default (experimental, opt-in). When on AND the user is signed in with
 * ChatGPT, Codex-eligible OpenAI models route through the subscription instead
 * of the user's API key.
 */
import { tryPlatform } from '@platform/platform';

import { CODEX_PREFER_SUBSCRIPTION_KEY } from './codexConstants';

/** Whether the user has switched on "prefer ChatGPT subscription". */
export function isPreferCodexSubscription(): boolean {
  return (
    tryPlatform()?.config.get<boolean>(CODEX_PREFER_SUBSCRIPTION_KEY, false) ??
    false
  );
}
