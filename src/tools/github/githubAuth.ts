/**
 * GitHub personal access token lookup.
 *
 * Host-neutral: reads from the platform secrets port (each host wires its own
 * secret store) with a `GITHUB_TOKEN` environment-variable fallback. The token
 * is persisted under `github.token` (set via the Git settings tab), while the
 * conventional env var is `GITHUB_TOKEN` — a different name — hence the explicit
 * second fallback. Because every host wires `platform().secrets`, GitHub tools
 * now work in the CLI and desktop too, not just the extension.
 */
import { tryPlatform } from '@platform/platform';

/** SecretStorage key under which the GitHub PAT is persisted. */
export const GITHUB_TOKEN_STORAGE_KEY = 'github.token';

export async function getGitHubToken(): Promise<string | undefined> {
  const stored = await tryPlatform()?.secrets.get(GITHUB_TOKEN_STORAGE_KEY);
  const token = stored ?? process.env.GITHUB_TOKEN;
  return token && token.length > 0 ? token : undefined;
}
