// Local imports - platform
import { platform } from '@platform/platform';
// Local imports - utilities
import { looksLikeCredentialPlaceholder } from '@utils/text/credentialPlaceholder';

interface StoreCredentialOptions {
  readonly secretName: string;
  readonly value: string;
  readonly kind?: 'provider' | 'github';
  readonly emptyMessage?: string;
  readonly placeholderMessage: string;
}

/** Validate, normalize, and persist a credential consistently across hosts. */
export async function storeCredential(
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

  await platform().secrets.set(options.secretName, normalized);
  return true;
}
