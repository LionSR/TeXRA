// The CLI's binding of the shared provider-key controller. Every terminal
// surface that writes a provider key — the "Connect a model" panel, `/key`,
// `/config`'s API-keys row, and the retry that asks for a key before
// switching a run onto it — goes through it, so the secret name, the label
// and the post-write refresh are the same three ways they are on the two
// graphical hosts. Its notices land in the chat transcript.

// Third-party imports
import type { Effect } from 'effect';

import { type ApiKeyProviderId } from '@texra-ai/llm';
import { SettingsProfileKeyController } from '@texra/controllers/settingsView/SettingsProfileKeyController';

import { tuiUi } from './tuiUiHost';
import type { Secrets, SettingsStores } from '@texra-ai/harness/plugins';

/** The shared controller on the TUI's prompt. A failed action is the
 *  controller's own failure; the chat words its cause after its message. */
const tuiKeys = (stores: SettingsStores) =>
  new SettingsProfileKeyController({ dialogs: tuiUi, stores });

/** Write a key the calling surface already holds. */
export const commitCliProviderApiKey = (
  stores: SettingsStores,
  provider: ApiKeyProviderId,
  key: string,
): Effect.Effect<void, Error, Secrets> =>
  tuiKeys(stores).commitProviderKey(provider, key);

/**
 * Ask for a provider key and write it: the `promptForApiKey` the shared
 * retry controller calls when a run's fallback needs a credential the user
 * has not stored yet. A dismissed prompt is the answer "no key", not a
 * failure — the retry controller re-reads the store and says the retry did
 * not switch.
 */
export const promptForCliProviderApiKey = (
  stores: SettingsStores,
  provider: ApiKeyProviderId,
): Effect.Effect<void, Error, Secrets> =>
  tuiKeys(stores).setProviderKey(provider);
