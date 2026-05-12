/**
 * Platform-agnostic secrets provider.
 *
 * Abstracts API key storage/retrieval. VS Code uses context.secrets +
 * process.env fallback. CLI/Electron uses process.env + config file.
 */

/**
 * Provider for secure secret storage (API keys, tokens).
 */
export interface PlatformSecrets {
  /** Get a raw secret by key name. */
  get(key: string): Promise<string | undefined>;

  /** Store a secret. */
  set(key: string, value: string): Promise<void>;

  /** Delete a secret. */
  delete(key: string): Promise<void>;
}
