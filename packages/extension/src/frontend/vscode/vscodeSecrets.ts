/**
 * VS Code adapter for the platform-agnostic PlatformSecrets.
 *
 * Uses vscode.SecretStorage for secure key storage. Environment variables
 * override persisted secrets, matching ElectronSecrets and CliSecrets so a
 * key exported in the environment behaves identically in every host.
 */
import * as vscode from 'vscode';

import type { PlatformSecrets } from '@platform/secrets';

export class VscodeSecrets implements PlatformSecrets {
  private readonly storage: vscode.SecretStorage;

  constructor(context: vscode.ExtensionContext) {
    this.storage = context.secrets;
  }

  async get(key: string): Promise<string | undefined> {
    const envValue = process.env[key];
    if (envValue !== undefined) return envValue;
    return this.getStored(key);
  }

  async getStored(key: string): Promise<string | undefined> {
    return this.storage.get(key);
  }

  async set(key: string, value: string): Promise<void> {
    await this.storage.store(key, value);
  }

  async delete(key: string): Promise<void> {
    await this.storage.delete(key);
  }

  async listStoredKeys(): Promise<readonly string[]> {
    try {
      return await this.storage.keys();
    } catch (error) {
      throw new Error(
        'SecretStorage key enumeration is not supported by this host. Stored secrets may still exist, but TeXRA cannot audit their names here.',
        { cause: error },
      );
    }
  }

  getEnv(name: string): string | undefined {
    return process.env[name];
  }
}
