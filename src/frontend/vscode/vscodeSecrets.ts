/**
 * VS Code adapter for the platform-agnostic PlatformSecrets.
 *
 * Uses vscode.SecretStorage for secure key storage, with
 * process.env fallback for API keys.
 */
import * as vscode from 'vscode';

import type { PlatformSecrets } from '@platform/secrets';

export class VscodeSecrets implements PlatformSecrets {
  private readonly storage: vscode.SecretStorage;

  constructor(context: vscode.ExtensionContext) {
    this.storage = context.secrets;
  }

  async get(key: string): Promise<string | undefined> {
    return this.storage.get(key);
  }

  async set(key: string, value: string): Promise<void> {
    await this.storage.store(key, value);
  }

  async delete(key: string): Promise<void> {
    await this.storage.delete(key);
  }
}
