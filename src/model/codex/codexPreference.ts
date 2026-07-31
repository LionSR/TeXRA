/**
 * The "prefer my ChatGPT subscription" switch.
 *
 * Off by default (experimental, opt-in). When on AND the user is signed in with
 * ChatGPT, Codex-eligible OpenAI models route through the subscription instead
 * of the user's API key.
 */
import { tryPlatform } from '@platform/platform';

import type { ConfigTarget } from '@platform/interfaces';

/** Config key for the "prefer my ChatGPT subscription" switch (off by default). */
export const CODEX_PREFER_SUBSCRIPTION_KEY =
  'texra.chatgptCodex.preferSubscription';

export interface CodexSubscriptionPreferenceUpdate {
  readonly effective: boolean;
  readonly target: ConfigTarget;
}

/** Whether the user has switched on "prefer ChatGPT subscription". */
export function isPreferCodexSubscription(): boolean {
  return (
    tryPlatform()?.config.get<boolean>(CODEX_PREFER_SUBSCRIPTION_KEY, false) ??
    false
  );
}

/** Update the preference at the scope that currently controls its value. */
export async function setPreferCodexSubscription(
  enabled: boolean,
): Promise<CodexSubscriptionPreferenceUpdate> {
  const host = tryPlatform();
  const inspection = host?.config.inspect<boolean>(
    CODEX_PREFER_SUBSCRIPTION_KEY,
  );
  const target: ConfigTarget =
    inspection?.workspaceValue !== undefined ? 'workspace' : 'global';
  if (!host) return { effective: false, target };

  await host.config.update(CODEX_PREFER_SUBSCRIPTION_KEY, enabled, target);
  return { effective: isPreferCodexSubscription(), target };
}
