/**
 * The "prefer my Kimi Code subscription" switch.
 *
 * Off by default (experimental, opt-in). When on AND the user is signed in
 * with Kimi Code, kimi-subscription-eligible Moonshot models route through the
 * subscription's OAuth session. Note the console API key is NOT gated by this
 * switch — the key is a documented plain credential for the same endpoint.
 */
import { tryPlatform } from '@platform/platform';

import {
  KIMI_CODE_PREFER_SUBSCRIPTION_KEY,
  KIMI_CODE_SUBSCRIPTION_TOOL_USE_ONLY_KEY,
} from './kimiCodeConstants';
import type { ConfigTarget } from '@platform/interfaces';

export interface KimiCodeSubscriptionPreferenceUpdate {
  readonly effective: boolean;
  readonly target: ConfigTarget;
}

/** Read a boolean preference, defaulting to off before platform init. */
function readKimiCodeFlag(key: string): boolean {
  return tryPlatform()?.config.get<boolean>(key, false) ?? false;
}

function kimiCodePreferenceUpdateTarget(key: string): ConfigTarget {
  const inspection = tryPlatform()?.config.inspect<boolean>(key);
  return inspection?.workspaceValue !== undefined ? 'workspace' : 'global';
}

/** Write a boolean preference at the scope that currently controls its value. */
async function writeKimiCodeFlag(
  key: string,
  enabled: boolean,
): Promise<KimiCodeSubscriptionPreferenceUpdate> {
  const host = tryPlatform();
  const target = kimiCodePreferenceUpdateTarget(key);
  if (!host) return { effective: false, target };

  await host.config.update(key, enabled, target);
  return { effective: readKimiCodeFlag(key), target };
}

/** Whether the user has switched on "prefer Kimi Code subscription". */
export function isPreferKimiCodeSubscription(): boolean {
  return readKimiCodeFlag(KIMI_CODE_PREFER_SUBSCRIPTION_KEY);
}

/**
 * Whether the Kimi Code subscription is restricted to tool-use agents (off by
 * default). When true, workflow agents skip the OAuth session and fall back to
 * the Kimi Code console API key — without one they fail, since these models
 * are not served by any other route. Read per request by the handler.
 */
export function isKimiCodeSubscriptionToolUseOnly(): boolean {
  return readKimiCodeFlag(KIMI_CODE_SUBSCRIPTION_TOOL_USE_ONLY_KEY);
}

/** Update the "subscription for tool-use only" switch at the controlling scope. */
export async function setKimiCodeSubscriptionToolUseOnly(
  enabled: boolean,
): Promise<KimiCodeSubscriptionPreferenceUpdate> {
  return writeKimiCodeFlag(KIMI_CODE_SUBSCRIPTION_TOOL_USE_ONLY_KEY, enabled);
}

/** Update the preference at the scope that currently controls its value. */
export async function setPreferKimiCodeSubscription(
  enabled: boolean,
): Promise<KimiCodeSubscriptionPreferenceUpdate> {
  return writeKimiCodeFlag(KIMI_CODE_PREFER_SUBSCRIPTION_KEY, enabled);
}
