import type { UsageRoute } from '@shared/schemas';

import { KIMI_CODE_BASE_URL } from './kimiCodeConstants';

type CredentialUsageRoute =
  'api-key' | 'chatgpt-subscription' | 'openrouter' | 'relay';

/** Preserve the product route represented by a lower-level credential route. */
export function resolveUsageRoute(
  config: { readonly baseUrl?: string },
  credentialRoute: CredentialUsageRoute | undefined,
): UsageRoute | undefined {
  switch (credentialRoute) {
    case 'chatgpt-subscription':
      return 'chatgpt-subscription';
    case 'relay':
      return 'relay';
    case 'api-key':
      return config.baseUrl === KIMI_CODE_BASE_URL
        ? 'kimi-code-subscription'
        : 'api-key';
    case 'openrouter':
      return 'api-key';
    default:
      return undefined;
  }
}
