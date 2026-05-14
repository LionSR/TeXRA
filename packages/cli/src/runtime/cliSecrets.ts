// Standard library imports
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Local imports - platform
import { DEFAULT_NODE_STORAGE_ROOT } from '@platform/defaults/nodeStorage';

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

  constructor(
    private readonly filePath = path.join(
      DEFAULT_NODE_STORAGE_ROOT,
      'secrets.json',
    ),
  ) {}

  async get(key: string): Promise<string | undefined> {
    return cliEnvValue(key) ?? (await this.readSecrets())[key];
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

  private async readSecrets(): Promise<SecretFileData> {
    try {
      const data = JSON.parse(await readFile(this.filePath, 'utf8')) as unknown;
      return isSecretFileData(data) ? data : {};
    } catch {
      return {};
    }
  }

  private async writeSecrets(data: SecretFileData): Promise<void> {
    const secretsDir = path.dirname(this.filePath);
    await mkdir(secretsDir, { recursive: true, mode: 0o700 });
    await chmod(secretsDir, 0o700);
    const tempPath = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(data, null, 2)}\n`, {
      mode: 0o600,
    });
    await rename(tempPath, this.filePath);
    await chmod(this.filePath, 0o600);
  }
}

let cliSecrets: CliSecrets | undefined;

export function getCliSecrets(): CliSecrets {
  cliSecrets ??= new CliSecrets();
  return cliSecrets;
}
