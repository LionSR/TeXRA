/**
 * The "prefer my ChatGPT subscription" switch.
 *
 * Off by default (experimental, opt-in). When on AND the user is signed in with
 * ChatGPT, Codex-eligible OpenAI models route through the subscription instead
 * of the user's API key.
 */
import { tryPlatform } from '@platform/platform';

import {
  CODEX_PREFER_SUBSCRIPTION_KEY,
  CODEX_SUBSCRIPTION_TOOL_USE_ONLY_KEY,
} from './codexConstants';
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

/**
 * Whether the ChatGPT subscription is restricted to tool-use agents (on by
 * default). When true, workflow agents skip the subscription and route through
 * the user's API key / relay — the Codex backend has no background mode and is
 * less stable for long workflow runs. Read per request by the Codex handler.
 */
export function isCodexSubscriptionToolUseOnly(): boolean {
  return (
    tryPlatform()?.config.get<boolean>(
      CODEX_SUBSCRIPTION_TOOL_USE_ONLY_KEY,
      true,
    ) ?? true
  );
}

/** Update the "subscription for tool-use only" switch at the controlling scope. */
export async function setCodexSubscriptionToolUseOnly(
  enabled: boolean,
): Promise<CodexSubscriptionPreferenceUpdate> {
  const host = tryPlatform();
  const target = codexPreferenceUpdateTarget(
    CODEX_SUBSCRIPTION_TOOL_USE_ONLY_KEY,
  );
  if (!host) return { effective: true, target };

  await host.config.update(
    CODEX_SUBSCRIPTION_TOOL_USE_ONLY_KEY,
    enabled,
    target,
  );
  return { effective: isCodexSubscriptionToolUseOnly(), target };
}

function codexPreferenceUpdateTarget(key: string): ConfigTarget {
  const inspection = tryPlatform()?.config.inspect<boolean>(key);
  return inspection?.workspaceValue !== undefined ? 'workspace' : 'global';
}

/** Update the preference at the scope that currently controls its value. */
export async function setPreferCodexSubscription(
  enabled: boolean,
): Promise<CodexSubscriptionPreferenceUpdate> {
  const host = tryPlatform();
  const target = codexPreferenceUpdateTarget(CODEX_PREFER_SUBSCRIPTION_KEY);
  if (!host) return { effective: false, target };

  await host.config.update(CODEX_PREFER_SUBSCRIPTION_KEY, enabled, target);
  return { effective: isPreferCodexSubscription(), target };
}
