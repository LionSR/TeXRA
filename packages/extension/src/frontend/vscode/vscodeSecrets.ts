/**
 * VS Code adapter for the platform-agnostic PlatformSecrets.
 *
 * Uses vscode.SecretStorage for secure key storage. Like ElectronSecrets and
 * CliSecrets it answers only what it holds; the environment tier of a
 * credential lives in `resolveCredential`, so it behaves identically in every
 * host.
 */
import { Effect } from 'effect';
import * as vscode from 'vscode';

import { SecretsFailed, type PlatformSecrets } from '@platform/secrets';
import { toErrorMessage } from '@utils/errors/errorMessage';

export class VscodeSecrets implements PlatformSecrets {
  private readonly storage: vscode.SecretStorage;

  constructor(context: vscode.ExtensionContext) {
    this.storage = context.secrets;
  }

  get(key: string) {
    return Effect.tryPromise({
      try: () => Promise.resolve(this.storage.get(key)),
      catch: (cause) =>
        new SecretsFailed({
          reason: 'io',
          operation: 'get',
          key,
          message: `VS Code could not read the secret "${key}": ${toErrorMessage(cause)}`,
          cause,
        }),
    });
  }

  /**
   * `SecretStorage.store` is the commit, so the whole call is the commit
   * region: host-controller study Q2 rules that it survives cancellation.
   * The `credentialChanged` signal is not emitted here:
   * `SecretStorage.onDidChange` emits it at the extension entry, which also
   * covers writes from other windows.
   */
  set(key: string, value: string) {
    return this.commit('set', () => this.storage.store(key, value), key);
  }

  /** The commit region of a removal, uninterruptible for the same reason. */
  delete(key: string) {
    return this.commit('delete', () => this.storage.delete(key), key);
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
