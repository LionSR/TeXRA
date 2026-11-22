/**
 * GitHub personal access token lookup.
 *
 * Host-neutral: reads from the secret store its caller hands it (each host
 * wires its own) with GitHub environment-variable fallbacks. The token is
 * persisted under `github.token` (set via the Git settings tab, `/config` →
 * GitHub token, or CLI secrets),
 * while the conventional env vars are `GH_TOKEN` and `GITHUB_TOKEN`; hence the
 * explicit fallback. Because every host provides the `Secrets` service, GitHub
 * tools work in the CLI and desktop too, not just the extension.
 */
import { Effect } from 'effect';

import {
  type CredentialOrigin,
  resolveCredential,
  type SecretsFailed,
} from '@texra-ai/llm';
import { Secrets, type PlatformSecrets } from '@texra-ai/worldline/plugins';
import { storeCredential } from '@texra/common/secrets/storeCredential';

/** SecretStorage key under which the GitHub PAT is persisted. */
export const GITHUB_TOKEN_STORAGE_KEY = 'github.token';

/**
 * GitHub "new personal access token" page, pre-filled with the description and
 * scope the subscription poller needs. Opened verbatim by every host.
 */
export const GITHUB_TOKEN_CREATE_URL =
  'https://github.com/settings/tokens/new?description=TeXRA%20PR%20subscription&scopes=repo';

/**
 * Prompt shown by the Git settings tab when asking for the token. The scope
 * wording has to agree with what {@link GITHUB_TOKEN_CREATE_URL} pre-fills, so
 * the two live together.
 */
export const GITHUB_TOKEN_PROMPT =
  'Paste a GitHub personal access token (repo or public_repo scope)';

/** Confirmation after the token is written to the host secret store. */
export const GITHUB_TOKEN_SAVED_MESSAGE = 'GitHub token saved.';

/** Confirmation after the token is cleared from the host secret store. */
export const GITHUB_TOKEN_REMOVED_MESSAGE = 'GitHub token removed.';

/** Environment variables accepted by GitHub tools, in precedence order. */
export const GITHUB_TOKEN_ENV_VARS = Object.freeze([
  'GH_TOKEN',
  'GITHUB_TOKEN',
] as const);

/** Store the token a host's token form was given: trimmed, and refused
 *  when it is empty or looks like a placeholder (`storeCredential`). */
export function saveGitHubToken(token: string) {
  return Effect.flatMap(Secrets, (secrets) =>
    storeCredential(secrets, {
      secretName: GITHUB_TOKEN_STORAGE_KEY,
      value: token,
      kind: 'github',
    }),
  );
}

/** Forget the stored token; the environment variables still apply. */
export const removeGitHubToken = Effect.flatMap(Secrets, (secrets) =>
  secrets.delete(GITHUB_TOKEN_STORAGE_KEY),
);

const resolveGitHubToken = (secrets: PlatformSecrets) =>
  resolveCredential(secrets, GITHUB_TOKEN_STORAGE_KEY, GITHUB_TOKEN_ENV_VARS);

export function getGitHubToken(
  secrets: PlatformSecrets,
): Effect.Effect<string | undefined, SecretsFailed> {
  return Effect.map(resolveGitHubToken(secrets), ({ value }) => value);
}

/**
 * Which source backs the GitHub token (a persisted secret wins over the env
 * vars), read through the same ladder as {@link getGitHubToken}, which is
 * what credential-status surfaces need.
 */
export function resolveGitHubTokenSource(
  secrets: PlatformSecrets,
): Effect.Effect<CredentialOrigin, SecretsFailed> {
  return Effect.map(resolveGitHubToken(secrets), ({ origin }) => origin);
}
