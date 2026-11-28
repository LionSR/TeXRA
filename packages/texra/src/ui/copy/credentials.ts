/**
 * Canonical copy for a provider key's origin (llm's `CredentialOrigin`) and
 * its prompt, so the settings webviews, the VS Code quick pick and the CLI
 * forms word them the same way.
 */
import type { CredentialOrigin } from '@texra-ai/llm';

/** How a provider key's `origin` reads. */
export function credentialOriginLabel(origin: CredentialOrigin): string {
  switch (origin) {
    case 'secret':
      return 'Key set';
    case 'env':
      return 'Env';
    case 'none':
      return 'Not set';
  }
}

/** Setting a provider's API key, named by its display name, wherever a
 *  surface offers it or asks for the key. */
export const PROVIDER_KEY_COPY = Object.freeze({
  /** Before a provider is chosen. */
  add: 'Add a provider API key',
  set: (provider: string): string => `Set ${provider} API key`,
  enter: (provider: string): string => `Enter ${provider} API key`,
});
