/**
 * VS Code adapter for the platform-agnostic PlatformSecrets.
 *
 * Uses vscode.SecretStorage for secure key storage. Environment variables
 * override persisted secrets, matching ElectronSecrets and CliSecrets so a
 * key exported in the environment behaves identically in every host.
 */
import { Effect } from 'effect';
import * as vscode from 'vscode';

import {
  SecretsFailed,
  secretsGet,
  type PlatformSecrets,
  type SecretsOperation,
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
    return this.call('getStored', key, () =>
      Promise.resolve(this.storage.get(key)),
    );
  }

  /** Uninterruptible commit region: see `PlatformSecrets` (study Q2). */
  set(key: string, value: string) {
    return Effect.uninterruptible(
      this.call('set', key, () =>
        Promise.resolve(this.storage.store(key, value)),
      ),
    );
  }

  /** Uninterruptible commit region: see `PlatformSecrets` (study Q2). */
  delete(key: string) {
    return Effect.uninterruptible(
      this.call('delete', key, () => Promise.resolve(this.storage.delete(key))),
    );
  }

  listStoredKeys(): Effect.Effect<readonly string[], SecretsFailed> {
    return Effect.tryPromise({
      try: async () => this.storage.keys(),
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

  getEnv(name: string): string | undefined {
    return process.env[name];
  }

  /** Every `SecretStorage` call fails the same way: the host rejected it. */
  private call<A>(
    operation: SecretsOperation,
    key: string,
    run: () => Promise<A>,
  ): Effect.Effect<A, SecretsFailed> {
    return Effect.tryPromise({
      try: run,
      catch: (cause) =>
        new SecretsFailed({
          reason: 'io',
          operation,
          key,
          message: `VS Code secret storage failed to ${operation} "${key}": ${toErrorMessage(cause)}`,
          cause,
        }),
    });
  }
}
