/**
 * VS Code adapter for the platform-agnostic PlatformSecrets.
 *
 * Uses vscode.SecretStorage for secure key storage. Environment variables
 * override persisted secrets, matching ElectronSecrets and CliSecrets so a
 * key exported in the environment behaves identically in every host.
 */
import { Effect } from 'effect';
import * as vscode from 'vscode';

import { invalidateApiKeyCache } from '@model/apiProviders';
import {
  SecretsFailed,
  secretsGet,
  type PlatformSecrets,
} from '@platform/secrets';
import { toErrorMessage } from '@utils/errors/errorMessage';

export class VscodeSecrets implements PlatformSecrets {
  private readonly storage: vscode.SecretStorage;

  constructor(context: vscode.ExtensionContext) {
    this.storage = context.secrets;
  }

  get(key: string) {
    return secretsGet(this, key);
  }

  getStored(key: string) {
    return Effect.tryPromise({
      try: () => Promise.resolve(this.storage.get(key)),
      catch: (cause) =>
        new SecretsFailed({
          reason: 'io',
          operation: 'getStored',
          key,
          message: `VS Code could not read the secret "${key}": ${toErrorMessage(cause)}`,
          cause,
        }),
    });
  }

  /**
   * `SecretStorage.store` is the commit, so the whole call is the commit
   * region: host-controller study Q2 rules that it survives cancellation.
   *
   * The API-key lookup cache drops in this store's own finalizer, before the
   * write returns, because a writer re-reads the key right after it (the
   * setup agent's `unset_api_key` does). The `credentialChanged` signal is
   * not emitted here: `SecretStorage.onDidChange` emits it at the extension
   * entry, which also covers writes from other windows.
   */
  set(key: string, value: string) {
    return Effect.ensuring(
      this.commit('set', () => this.storage.store(key, value), key),
      Effect.sync(invalidateApiKeyCache),
    );
  }

  /** The commit region of a removal, uninterruptible for the same reason. */
  delete(key: string) {
    return Effect.ensuring(
      this.commit('delete', () => this.storage.delete(key), key),
      Effect.sync(invalidateApiKeyCache),
    );
  }

  private commit(
    operation: 'set' | 'delete',
    write: () => Thenable<void>,
    key: string,
  ) {
    return Effect.uninterruptible(
      Effect.tryPromise({
        try: () => Promise.resolve(write()),
        catch: (cause) =>
          new SecretsFailed({
            reason: 'io',
            operation,
            key,
            message: `VS Code could not ${operation === 'set' ? 'store' : 'remove'} the secret "${key}": ${toErrorMessage(cause)}`,
            cause,
          }),
      }),
    );
  }

  listStoredKeys() {
    return Effect.tryPromise({
      try: () => Promise.resolve(this.storage.keys()),
      catch: (cause) =>
        new SecretsFailed({
          reason: 'enumeration-unsupported',
          operation: 'listStoredKeys',
          message:
            'SecretStorage key enumeration is not supported by this host. Stored secrets may still exist, but TeXRA cannot audit their names here.',
          cause,
        }),
    });
  }
}
