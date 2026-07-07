/**
 * VS Code adapter for the platform-agnostic StorageProvider.
 *
 * Uses context.storageUri and context.globalStorageUri.
 */
import * as vscode from 'vscode';

import type { StorageProvider } from '@platform/interfaces';

export class VscodeStorage implements StorageProvider {
  constructor(private readonly context: vscode.ExtensionContext) {}

  getStoragePath(): string {
    if (!this.context.storageUri) {
      throw new Error(
        'VS Code storage URI not available. Extension context may not be initialized.',
      );
    }
    return this.context.storageUri.fsPath;
  }

  getGlobalStoragePath(): string {
    if (!this.context.globalStorageUri) {
      throw new Error(
        'VS Code global storage URI not available. Extension context may not be initialized.',
      );
    }
    return this.context.globalStorageUri.fsPath;
  }
}
