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

/** SecretStorage key under which the GitHub PAT is persisted. */
export const GITHUB_TOKEN_STORAGE_KEY = 'github.token';

/** Environment variables accepted by GitHub tools, in precedence order. */
export const GITHUB_TOKEN_ENV_VARS = ['GH_TOKEN', 'GITHUB_TOKEN'] as const;

export function normalizeGitHubToken(
  token: string | undefined,
): string | undefined {
  const trimmed = token?.trim();
  return trimmed ? trimmed : undefined;
}

export function getGitHubEnvToken(): string | undefined {
  for (const envVar of GITHUB_TOKEN_ENV_VARS) {
    const token = normalizeGitHubToken(process.env[envVar]);
    if (token) return token;
  }
  return undefined;
}

export async function getGitHubToken(): Promise<string | undefined> {
  const stored = await tryPlatform()?.secrets.get(GITHUB_TOKEN_STORAGE_KEY);
  return normalizeGitHubToken(stored) ?? getGitHubEnvToken();
}
