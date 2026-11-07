/**
 * Each OAuth subscription's (ChatGPT, Grok) "prefer my subscription" switch.
 *
 * The switches are off by default (experimental, opt-in). When one is on AND
 * the user is signed in, the provider's eligible models route through the
 * subscription instead of the user's API key; `readModelSettings` reads the
 * sign-in from the session store (`@texra-ai/llm/node`).
 */
import {
  Settings,
  type ConfigTarget,
  type ConfigWriteFailed,
  type SettingsStores,
} from '@shared/config/settings';
import type { SubscriptionAuthProvider } from '@shared/model/subscriptionAuth';
import {
  CHATGPT_PREFER_SUBSCRIPTION_SETTING,
  XAI_PREFER_SUBSCRIPTION_SETTING,
  type SettingRow,
} from '@shared/state/stateSettings';
import type { Effect } from 'effect';

/** Each provider's "prefer my subscription" switch. */
const PREFER_SUBSCRIPTION: Readonly<
  Record<SubscriptionAuthProvider, SettingRow<boolean>>
> = {
  chatgpt: CHATGPT_PREFER_SUBSCRIPTION_SETTING,
  grok: XAI_PREFER_SUBSCRIPTION_SETTING,
};

/** Whether the user has switched on "prefer my subscription" for `provider`. */
function isPreferSubscription(
  provider: SubscriptionAuthProvider,
  stores: SettingsStores,
): boolean {
  return Settings.getConfig(stores.config, PREFER_SUBSCRIPTION[provider]);
}

/**
 * Persist the preference in the scope that controls it. An `Effect`, so the
 * caller's program owns the write and its failure rather than receiving a
 * rejection it cannot compose. The value read back is always `enabled`:
 * every host's config is a layered `JsonConfigProvider`, and the write
 * lands in the layer that wins, so no more specific setting can override it.
 */
function setPreferSubscription(
  provider: SubscriptionAuthProvider,
  stores: SettingsStores,
  enabled: boolean,
): Effect.Effect<void, ConfigWriteFailed | Error> {
  const row = PREFER_SUBSCRIPTION[provider];
  // The scope that currently controls the value: a project that already
  // names the preference keeps owning it, everyone else writes the user
  // file. Passed to the catalog write path as the explicit target, so the
  // row's schema still validates the value.
  const inspection = stores.config.inspect<boolean>(row.key);
  const target: ConfigTarget =
    inspection.workspaceValue !== undefined ? 'workspace' : 'global';
  return Settings.set(stores, row, enabled, target);
}

/** Each subscription's "prefer my subscription" switch: its read (`get`) and
 *  its write in the scope that controls it (`set`). */
export const SubscriptionPreference = Object.freeze({
  get: isPreferSubscription,
  set: setPreferSubscription,
});
