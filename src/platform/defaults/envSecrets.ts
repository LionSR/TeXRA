/**
 * Default secrets provider for CLI / Electron / tests.
 *
 * Reads API keys from environment variables. Writes are no-ops
 * (env vars are read-only at runtime).
 */
import type { PlatformSecrets } from '../secrets';

/**
 * Environment-variable-backed secrets provider.
 * Key names are used directly as env var names.
 */
export class EnvSecrets implements PlatformSecrets {
  async get(key: string): Promise<string | undefined> {
    return process.env[key];
  }

  async set(_key: string, _value: string): Promise<void> {
    // Environment variables are read-only in a running process.
    // CLI/Electron hosts should persist keys to a config file separately.
  }

  async delete(_key: string): Promise<void> {
    // No-op — see set() comment.
  }
}
