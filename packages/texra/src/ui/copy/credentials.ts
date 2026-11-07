/**
 * Canonical copy for a credential's origin (llm's `CredentialOrigin`) and the
 * GitHub token's actions, so the settings webviews, the VS Code quick pick
 * and the CLI forms word them the same way.
 */
import type { CredentialOrigin } from '@texra-ai/llm';

/** The noun each kind of credential reads as when it is stored. */
const STORED_LABEL = Object.freeze({ key: 'Key set', token: 'Token set' });

/** How `origin` reads for a credential of `kind` (an API key, a token). */
export function credentialOriginLabel(
  origin: CredentialOrigin,
  kind: keyof typeof STORED_LABEL,
): string {
  switch (origin) {
    case 'secret':
      return STORED_LABEL[kind];
    case 'env':
      return 'Env';
    case 'none':
      return 'Not set';
  }
}

/** The GitHub token's actions, wherever they are offered. */
export const TOKEN_ACTION_COPY = Object.freeze({
  set: 'Set token',
  replace: 'Replace token',
  remove: 'Remove token',
  create: 'Create on GitHub…',
});
