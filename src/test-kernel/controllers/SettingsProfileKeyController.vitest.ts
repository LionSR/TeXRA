import { strict as assert } from 'node:assert';

import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { describe } from 'vitest';

import { SecretsFailed } from '@texra-ai/llm';
import { createFakeUIHosts } from '@test/support/FakeHosts';
import { FakeSecrets } from '@test/support/FakePlatform';
import { makeFakeSettingsStores } from '@test/support/settingsStoresFake';
import { SettingsProfileKeyController } from '@texra/controllers/settingsView/SettingsProfileKeyController';

async function createController(options?: {
  inputResponses?: readonly (string | undefined)[];
  confirmResponses?: readonly boolean[];
  setError?: Error;
  deleteError?: Error;
}): Promise<{
  controller: SettingsProfileKeyController;
  hosts: ReturnType<typeof createFakeUIHosts>;
  secrets: FakeSecrets;
  deleted: string[];
}> {
  const hosts = createFakeUIHosts({
    inputResponses: options?.inputResponses,
    confirmResponses: options?.confirmResponses ?? [true],
  });
  const secrets = new FakeSecrets();
  const deleted: string[] = [];

  const originalSet = secrets.set.bind(secrets);
  secrets.set = (key, value) =>
    options?.setError
      ? Effect.fail(storeFailure('set', key, options.setError))
      : originalSet(key, value);
  const originalDelete = secrets.delete.bind(secrets);
  secrets.delete = (key) =>
    options?.deleteError
      ? Effect.fail(storeFailure('delete', key, options.deleteError))
      : Effect.andThen(
          Effect.sync(() => {
            deleted.push(key);
          }),
          originalDelete(key),
        );
  return {
    controller: new SettingsProfileKeyController({
      secrets,
      prompt: hosts.prompt,
      stores: makeFakeSettingsStores().stores,
    }),
    hosts,
    secrets,
    deleted,
  };
}

/** A credential store that refuses the write, as the port reports it. */
function storeFailure(
  operation: 'set' | 'delete',
  key: string,
  cause: Error,
): SecretsFailed {
  return new SecretsFailed({
    reason: 'io',
    operation,
    key,
    message: cause.message,
    cause,
  });
}

describe('SettingsProfileKeyController', () => {
  // Regression pin: the placeholder guard used to live only in the CLI, so the
  // graphical hosts happily wrote `sk-xxxxxx` into the secret store.
  it.effect('reports a placeholder key instead of storing it', () =>
    Effect.gen(function* () {
      const { controller, secrets } = yield* Effect.promise(() =>
        createController(),
      );

      const failure = yield* Effect.flip(
        controller.commitProviderKey('openai', 'sk-xxxxxx'),
      );

      assert.equal(yield* secrets.get('apiKey.openai'), undefined);
      assert.match(failure.message, /Failed to set OpenAI API key/);
      assert.match(String(failure.cause), /looks like a placeholder/);
    }),
  );
});
