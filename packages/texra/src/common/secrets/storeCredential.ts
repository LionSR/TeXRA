import { Effect } from 'effect';

const PROVIDER_PLACEHOLDER_PATTERNS: readonly RegExp[] = [
  /^(sk-?)?(x{3,}|\*{3,}|\.{3,}|<.*>|your[- _]?(?:api[- _]?)?key)/i,
  /^(?:api[- _]?)?key[- _]?here$/i,
  /^placeholder$/i,
  /^example$/i,
];

const GITHUB_PLACEHOLDER_PATTERNS: readonly RegExp[] = [
  /^(?:(?:gh[pousr]_|github_pat_)|sk-?)?(?:x{3,}|\*{3,}|\.{3,}|<.*>|your[- _]?.*)/i,
  /^\[.*(?:redacted|github[- _]?token).*\]/i,
  /^(?:(?:api|github)[- _]?)?(?:key|token)[- _]?here$/i,
  /^placeholder$/i,
  /^example$/i,
];

/** Reject common masked/example values before they enter the secret store. */
function looksLikeCredentialPlaceholder(
  value: string,
  kind: 'provider' | 'github',
): boolean {
  if (value.length < 8) return true;
  const patterns =
    kind === 'github'
      ? GITHUB_PLACEHOLDER_PATTERNS
      : PROVIDER_PLACEHOLDER_PATTERNS;
  return patterns.some((pattern) => pattern.test(value));
}

/**
 * The one member of the credential store this needs, generic over whatever
 * that store fails with, so the rule lives here without this module knowing
 * the platform port that carries it.
 */
interface CredentialStore<E> {
  set(secretName: string, value: string): Effect.Effect<void, E>;
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
 * credential and a failed store are both failures of the returned program:
 * every caller already funnels them into its own failure reporting, and the
 * store's own typed failure reaches that reporting unchanged.
 */
export function storeCredential<E>(
  store: CredentialStore<E>,
  options: StoreCredentialOptions,
): Effect.Effect<void, Error | E> {
  return Effect.suspend((): Effect.Effect<void, Error | E> => {
    const subject =
      options.kind === 'github'
        ? 'GitHub token'
        : `${options.label ?? 'provider'} API key`;
    const normalized = options.value.trim();
    if (!normalized) {
      return Effect.fail(new Error(`${subject} is empty.`));
    }
    if (looksLikeCredentialPlaceholder(normalized, options.kind)) {
      return Effect.fail(
        new Error(
          options.kind === 'github'
            ? `This looks like a placeholder rather than a ${subject}. Enter a personal access token from GitHub.`
            : `This looks like a placeholder rather than a ${subject}. Enter the key issued by the provider.`,
        ),
      );
    }
    return store.set(options.secretName, normalized);
  });
}
