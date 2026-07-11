// Standard library imports
import { chmod, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

// Third-party imports
import writeFileAtomic from 'write-file-atomic';

// Local imports - platform
import { DEFAULT_NODE_STORAGE_ROOT } from '@platform/defaults/nodeStorage';

// Local imports - common
import { isFileNotFoundError } from '@common/errors';

// Local imports - CLI runtime
import { cliEnvValue } from './cliContext';

// Type imports - platform
import type { PlatformSecrets } from '@platform/secrets';

type SecretFileData = Record<string, string>;

function isSecretFileData(value: unknown): value is SecretFileData {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === 'string')
  );
}

/**
 * CLI secret storage.
 *
 * Environment variables remain the highest-priority source so automation can
 * keep using ephemeral keys. Values written by CLI login are persisted under
 * the user's TeXRA state directory.
 */
export class CliSecrets implements PlatformSecrets {
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath = cliSecretsPath()) {}

  async get(key: string): Promise<string | undefined> {
    return cliEnvValue(key) ?? (await this.getStored(key));
  }

  async getStored(key: string): Promise<string | undefined> {
    return (await this.readSecrets())[key];
  }

  async set(key: string, value: string): Promise<void> {
    await this.updateSecrets((data) => {
      data[key] = value;
    });
  }

  async delete(key: string): Promise<void> {
    await this.updateSecrets((data) => {
      delete data[key];
    });
  }

  async listStoredKeys(): Promise<readonly string[]> {
    return Object.keys(await this.readSecrets());
  }

  getEnv(name: string): string | undefined {
    return cliEnvValue(name);
  }

  private async updateSecrets(
    mutator: (data: SecretFileData) => void,
  ): Promise<void> {
    const mutation = this.mutationQueue.then(async () => {
      const data = await this.readSecrets();
      mutator(data);
      await this.writeSecrets(data);
    });
    this.mutationQueue = mutation.catch(() => {});
    await mutation;
  }

  /**
   * Reads the secrets file. A missing file is the expected first-run state
   * and defaults to `{}`. Any other read failure (permissions, corrupt
   * JSON, etc.) is rethrown rather than swallowed: `updateSecrets()` does a
   * read-mutate-write, so silently defaulting to `{}` here would make a
   * transient read failure permanently wipe every other stored secret on
   * the next write.
   */
  private async readSecrets(): Promise<SecretFileData> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if (isFileNotFoundError(error)) return {};
      throw error;
    }
    const data = JSON.parse(raw) as unknown;
    return isSecretFileData(data) ? data : {};
  }

  private async writeSecrets(data: SecretFileData): Promise<void> {
    const secretsDir = path.dirname(this.filePath);
    await mkdir(secretsDir, { recursive: true, mode: 0o700 });
    await chmod(secretsDir, 0o700);
    // write-file-atomic stages to a sibling temp, fsyncs, and renames over
    // the target, so a crash mid-write can't leave a truncated secrets file.
    await writeFileAtomic(this.filePath, `${JSON.stringify(data, null, 2)}\n`, {
      mode: 0o600,
    });
  }
}

export function cliSecretsPath(
  storageRoot = DEFAULT_NODE_STORAGE_ROOT,
): string {
  return path.join(storageRoot, 'secrets.json');
}

let cliSecrets: CliSecrets | undefined;

export function getCliSecrets(storageRoot?: string): CliSecrets {
  cliSecrets ??= new CliSecrets(cliSecretsPath(storageRoot));
  return cliSecrets;
}
