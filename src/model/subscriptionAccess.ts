/**
 * The OAuth subscriptions (ChatGPT, Grok) as the model layer sees them: each
 * provider's "prefer my subscription" switch, and whether a session is signed
 * in.
 *
 * The switches are off by default (experimental, opt-in). When one is on AND
 * the user is signed in, the provider's eligible models route through the
 * subscription instead of the user's API key. The OAuth machinery lives
 * outside the model layer (`@texra-ai/llm/node`), so the model layer holds only the
 * sign-in answer, not the plumbing: an app that supports subscription sign-in
 * installs a probe at startup, and an embedder that does not simply never
 * signs in. Signed out is the honest default — it routes model selection to
 * API keys rather than to a subscription that cannot be reached.
 */
import { Effect } from 'effect';

import type { ConfigTarget, ConfigWriteFailed } from '@platform/interfaces';
import {
  readConfigSetting,
  type SettingsStores,
} from '@shared/config/settingsAccess';
import type { SubscriptionAuthStatus } from '@shared/settingsView/settingsViewMessages';
import { settingByKey } from '@shared/state/stateSettings';
import { writeSettingTo } from '@utils/config/platformSettings';

type SubscriptionAuthProvider = SubscriptionAuthStatus['provider'];

/** Reads the current sign-in state. Never fails; never hits the network. */
type SignedInProbe = () => Effect.Effect<boolean>;

/** Config key of each provider's "prefer my subscription" switch. */
const PREFER_SUBSCRIPTION_KEYS: Readonly<
  Record<SubscriptionAuthProvider, string>
> = {
  chatgpt: 'texra.chatgptCodex.preferSubscription',
  grok: 'texra.xaiGrok.preferSubscription',
};

const SIGNED_OUT: SignedInProbe = () => Effect.succeed(false);

const signedInProbes: Record<SubscriptionAuthProvider, SignedInProbe> = {
  chatgpt: SIGNED_OUT,
  grok: SIGNED_OUT,
};

/** Whether the user has switched on "prefer my subscription" for `provider`. */
export function isPreferSubscription(
  provider: SubscriptionAuthProvider,
  stores: SettingsStores,
): boolean {
  const configKey = PREFER_SUBSCRIPTION_KEYS[provider];
  const entry = settingByKey(configKey);
  if (!entry) throw new Error(`No setting catalog entry for key: ${configKey}`);
  return readConfigSetting(entry, stores.config) as boolean;
}

/**
 * Persist the preference in the scope that controls it. An `Effect`, so the
 * caller's program owns the write and its failure rather than receiving a
 * rejection it cannot compose. The value read back is always `enabled`:
 * every host's config is a layered `JsonConfigProvider`, and the write
 * lands in the layer that wins, so no more specific setting can override it.
 */
export function setPreferSubscription(
  provider: SubscriptionAuthProvider,
  stores: SettingsStores,
  enabled: boolean,
): Effect.Effect<void, ConfigWriteFailed | Error> {
  const configKey = PREFER_SUBSCRIPTION_KEYS[provider];
  // The scope that currently controls the value: a project that already
  // names the preference keeps owning it, everyone else writes the user
  // file. Passed to the catalog write path as the explicit target, so the
  // row's schema still validates the value.
  const inspection = stores.config.inspect<boolean>(configKey);
  const target: ConfigTarget =
    inspection?.workspaceValue !== undefined ? 'workspace' : 'global';
  return writeSettingTo(stores, configKey, enabled, target);
}

/**
 * Install the app's sign-in probe for `provider`. Called once per process
 * from the host composition root.
 */
export function setSignedInProbe(
  provider: SubscriptionAuthProvider,
  probe: SignedInProbe,
): void {
  signedInProbes[provider] = probe;
}

/** Whether a `provider` subscription session is currently signed in. */
export function isSubscriptionSignedIn(
  provider: SubscriptionAuthProvider,
): Effect.Effect<boolean> {
  return signedInProbes[provider]();
}
