/**
 * GitHub personal access token lookup.
 *
 * Host-neutral: reads from the platform secrets port (each host wires its own
 * secret store) with GitHub environment-variable fallbacks. The token is
 * persisted under `github.token` (set via the Git settings tab, `/config` →
 * GitHub token, or CLI secrets),
 * while the conventional env vars are `GH_TOKEN` and `GITHUB_TOKEN`; hence the
 * explicit fallback. Because every host wires `platform().secrets`, GitHub
 * tools work in the CLI and desktop too, not just the extension.
 */
import { platform } from '@platform/platform';
import type { PlatformSecrets } from '@platform/secrets';

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
const GITHUB_TOKEN_ENV_VARS = ['GH_TOKEN', 'GITHUB_TOKEN'] as const;

function normalizeGitHubToken(token: string | undefined): string | undefined {
  const trimmed = token?.trim();
  return trimmed || undefined;
}

function getGitHubEnvToken(
  readEnv: (name: string) => string | undefined,
): string | undefined {
  for (const envVar of GITHUB_TOKEN_ENV_VARS) {
    const token = normalizeGitHubToken(readEnv(envVar));
    if (token) return token;
  }
  return undefined;
}

export async function getGitHubToken(): Promise<string | undefined> {
  // Every caller runs post-init (tool status probes, GitHub client, setup
  // commands), so an uninitialized platform here is a programming error and
  // must throw instead of silently degrading to a process.env read.
  const secrets = platform().secrets;
  const stored = await secrets.get(GITHUB_TOKEN_STORAGE_KEY);
  return (
    normalizeGitHubToken(stored) ??
    getGitHubEnvToken((name) => secrets.getEnv(name))
  );
}

/**
 * Precedence-ordered GitHub-token *source* check: a persisted secret wins
 * over environment-variable fallbacks. Unlike `getGitHubToken`, this reports
 * which source backs the token (rather than the token value itself), which
 * is what credential-status surfaces need. Single owner for the setup tool's
 * environment probe (`src/tools/setup/platform.ts`) and the extension's
 * `SecretManager.gitHubTokenExists()`, which previously duplicated this
 * precedence chain.
 */
export async function resolveGitHubTokenSource(
  secrets: PlatformSecrets,
): Promise<'secret' | 'env' | 'none'> {
  if (normalizeGitHubToken(await secrets.getStored(GITHUB_TOKEN_STORAGE_KEY))) {
    return 'secret';
  }
  return getGitHubEnvToken((name) => secrets.getEnv(name)) ? 'env' : 'none';
}
