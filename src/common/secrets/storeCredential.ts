// Third-party imports
import { Effect } from 'effect';

// Local imports - utilities
import type { SecretsFailed } from '@platform/secrets';
import { looksLikeCredentialPlaceholder } from '@utils/text/credentialPlaceholder';

interface CredentialStore {
  set(secretName: string, value: string): Effect.Effect<void, SecretsFailed>;
}

interface StoreCredentialOptions {
  readonly secretName: string;
  readonly value: string;
  readonly kind: 'provider' | 'github';
  /**
   * Provider display name woven into the rejection messages. Caller-supplied
   * because hosts resolve it through their own (region-aware) provider config;
   * looking it up here would silently drop those variants.
   */
  readonly label?: string;
}

/**
 * Validate, normalize, and persist a credential consistently across hosts.
 * The rejection copy lives here too, so the CLI, the desktop app, and the
 * extension can't drift on what a rejected credential says. A rejected
 * credential throws, as it did: every caller already funnels thrown errors
 * into its own failure reporting, and the store's own failure stays typed.
 */
export const storeCredential = Effect.fn('secrets.storeCredential')(function* (
  store: CredentialStore,
  options: StoreCredentialOptions,
) {
  const subject =
    options.kind === 'github'
      ? 'GitHub token'
      : `${options.label ?? 'provider'} API key`;
  const normalized = options.value.trim();
  if (!normalized) throw new Error(`${subject} is empty.`);
  if (looksLikeCredentialPlaceholder(normalized, options.kind)) {
    throw new Error(
      options.kind === 'github'
        ? `This looks like a placeholder rather than a ${subject}. Enter a personal access token from GitHub.`
        : `This looks like a placeholder rather than a ${subject}. Enter the key issued by the provider.`,
    );
  }

  yield* store.set(options.secretName, normalized);
});
