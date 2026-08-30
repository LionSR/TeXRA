/**
 * Platform-agnostic secrets provider.
 *
 * Abstracts API key storage/retrieval. VS Code uses context.secrets +
 * process.env fallback. CLI/Electron uses process.env + config file.
 */

import { createLog } from '@logger/logUtils';

const log = createLog('PlatformSecrets');

/**
 * Provider for secure secret storage (API keys, tokens).
 */
export interface PlatformSecrets {
  /** Get a raw secret by key name. */
  get(key: string): Promise<string | undefined>;

  /**
   * Get a persisted secret without applying environment-variable overrides.
   * This lets credential-management code distinguish a stored key from an
   * equally named key supplied by the process environment.
   */
  getStored(key: string): Promise<string | undefined>;

  /** Store a secret. */
  set(key: string, value: string): Promise<void>;

  /** Delete a secret. */
  delete(key: string): Promise<void>;

  /**
   * List persisted secret names without exposing their values.
   * Used only by credential-audit surfaces.
   */
  listStoredKeys(): Promise<readonly string[]>;

  /**
   * Read a conventional environment variable (e.g. `ANTHROPIC_API_KEY`).
   * Distinct from `get()`, which is keyed by the internal secret-storage
   * name (e.g. `apiKey.anthropic`) and already applies its own env override
   * for that name. Callers that fall back to a differently-named
   * conventional env var (see `apiKeyEnvName`) go through this seam instead
   * of reading `process.env` directly, so the fallback stays host-agnostic
   * and mockable in tests.
   */
  getEnv(name: string): string | undefined;
}

/** Surface a credential read failure before a caller degrades to unavailable. */
export function warnSecretReadFailure(
  credentialLabel: string,
  error: unknown,
): void {
  log.warn(`Failed to read ${credentialLabel}; treating it as unavailable.`, {
    data: error,
  });
}

/**
 * Shared `get()` shape every {@link PlatformSecrets} implementation follows:
 * an environment-variable override, else the persisted value. Each host's
 * `get()` becomes a one-line call to this with its own env lookup.
 */
export async function secretWithEnvOverride(
  key: string,
  getEnv: (key: string) => string | undefined,
  getStored: (key: string) => Promise<string | undefined>,
): Promise<string | undefined> {
  const envValue = getEnv(key);
  return envValue !== undefined ? envValue : getStored(key);
}
