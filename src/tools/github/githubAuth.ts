/**
 * GitHub personal access token lookup.
 *
 * Host-neutral: reads from the platform secrets port (each host wires its own
 * secret store) with GitHub environment-variable fallbacks. The token is
 * persisted under `github.token` (set via the Git settings tab or CLI secrets),
 * while the conventional env vars are `GH_TOKEN` and `GITHUB_TOKEN`; hence the
 * explicit fallback. Because every host wires `platform().secrets`, GitHub
 * tools work in the CLI and desktop too, not just the extension.
 */
import { tryPlatform } from '@platform/platform';
import type { PlatformSecrets } from '@platform/secrets';

/** SecretStorage key under which the GitHub PAT is persisted. */
export const GITHUB_TOKEN_STORAGE_KEY = 'github.token';

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
  const secrets = tryPlatform()?.secrets;
  // No platform yet (e.g. module-level init before `initPlatform()` runs):
  // there's no secrets seam to call, so read process.env directly — same
  // documented pre-init exception as `tryPlatform()` itself.
  if (!secrets) return getGitHubEnvToken((name) => process.env[name]);
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
