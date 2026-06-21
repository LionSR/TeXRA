/**
 * The "prefer my ChatGPT subscription" switch.
 *
 * Off by default (experimental, opt-in). When on AND the user is signed in with
 * ChatGPT, Codex-eligible OpenAI models route through the subscription instead
 * of the user's API key.
 */
import { tryPlatform } from '@platform/platform';

import { CODEX_PREFER_SUBSCRIPTION_KEY } from './codexConstants';
import type { ConfigTarget } from '@platform/interfaces/config';

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

function codexPreferenceUpdateTarget(): ConfigTarget {
  const inspection = tryPlatform()?.config.inspect<boolean>(
    CODEX_PREFER_SUBSCRIPTION_KEY,
  );
  return inspection?.workspaceValue !== undefined ||
    inspection?.workspaceFolderValue !== undefined
    ? 'workspace'
    : 'global';
}

/** Update the preference at the scope that currently controls its value. */
export async function setPreferCodexSubscription(
  enabled: boolean,
): Promise<CodexSubscriptionPreferenceUpdate> {
  const host = tryPlatform();
  const target = codexPreferenceUpdateTarget();
  if (!host) return { effective: false, target };

  await host.config.update(CODEX_PREFER_SUBSCRIPTION_KEY, enabled, target);
  return { effective: isPreferCodexSubscription(), target };
}
