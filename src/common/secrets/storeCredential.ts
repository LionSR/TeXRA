// Local imports - utilities
import { looksLikeCredentialPlaceholder } from '@utils/text/credentialPlaceholder';

interface CredentialStore {
  set(secretName: string, value: string): Promise<void>;
}

interface StoreCredentialOptions {
  readonly secretName: string;
  readonly value: string;
  readonly kind?: 'provider' | 'github';
  readonly emptyMessage?: string;
  readonly placeholderMessage: string;
}

/** Validate, normalize, and persist a credential consistently across hosts. */
export async function storeCredential(
  store: CredentialStore,
  options: StoreCredentialOptions,
): Promise<boolean> {
  const normalized = options.value.trim();
  if (!normalized) {
    if (options.emptyMessage) throw new Error(options.emptyMessage);
    return false;
  }
  if (looksLikeCredentialPlaceholder(normalized, options.kind)) {
    throw new Error(options.placeholderMessage);
  }

  await store.set(options.secretName, normalized);
  return true;
}
