import { strict as assert } from 'node:assert';

import { it } from '@effect/vitest';
import { Cause, Effect, Exit } from 'effect';
import { describe } from 'vitest';

import { SettingsProfileKeyController } from '@controllers/settingsView/SettingsProfileKeyController';
import { SecretsFailed } from '@platform/secrets';
import { createFakeUIHosts } from '@test/support/FakeHosts';
import { FakeSecrets } from '@test/support/FakePlatform';

async function createController(options?: {
  inputResponses?: readonly (string | undefined)[];
  confirmResponses?: readonly boolean[];
  urls?: Record<string, string | undefined>;
  setError?: Error;
  deleteError?: Error;
}): Promise<{
  controller: SettingsProfileKeyController;
  hosts: ReturnType<typeof createFakeUIHosts>;
  secrets: FakeSecrets;
  deleted: string[];
  failures: string[];
  refreshCount: () => number;
}> {
  const hosts = createFakeUIHosts({
    inputResponses: options?.inputResponses,
    confirmResponses: options?.confirmResponses ?? [true],
  });
  const secrets = new FakeSecrets();
  const deleted: string[] = [];
  const failures: string[] = [];
  let refreshCount = 0;

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
      externalOpener: hosts.externalOpener,
      getProviderDisplayName: (provider) =>
        provider === 'openai' ? 'OpenAI' : provider,
      getProviderKeyUrl: (provider) => options?.urls?.[provider],
      refreshAfterKeyChange: () =>
        Effect.sync(() => {
          refreshCount += 1;
        }),
      reportFailure: (message, error) =>
        Effect.sync(() => {
          failures.push(`${message}: ${String(error)}`);
        }),
    }),
    hosts,
    secrets,
    deleted,
    failures,
    refreshCount: () => refreshCount,
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
  it.effect('stores provider keys and refreshes dependent state', () =>
    Effect.gen(function* () {
      const { controller, hosts, secrets, refreshCount } =
        yield* Effect.promise(() =>
          createController({
            inputResponses: ['  sk-real-openai-key  '],
          }),
        );

      yield* controller.setProviderKey('openai');

      assert.equal(yield* secrets.get('apiKey.openai'), 'sk-real-openai-key');
      assert.equal(refreshCount(), 1);
      assert.equal(
        hosts.prompt.inputs[0]?.options.prompt,
        'Enter OpenAI API key',
      );
      assert.equal(hosts.prompt.inputs[0]?.options.password, true);
      assert.equal(
        hosts.prompt.messages.at(-1)?.message,
        'OpenAI API key has been set',
      );
    }),
  );

  it.effect('does nothing when provider key input is cancelled', () =>
    Effect.gen(function* () {
      const { controller, secrets, refreshCount, hosts } =
        yield* Effect.promise(() =>
          createController({
            inputResponses: [undefined],
          }),
        );

      yield* controller.setProviderKey('openai');

      assert.equal(yield* secrets.get('apiKey.openai'), undefined);
      assert.equal(refreshCount(), 0);
      assert.equal(hosts.prompt.messages.length, 0);
    }),
  );

  // Regression pin: the placeholder guard used to live only in the CLI, so the
  // graphical hosts happily wrote `sk-xxxxxx` into the secret store.
  it.effect('reports a placeholder key instead of storing it', () =>
    Effect.gen(function* () {
      const { controller, secrets, failures, refreshCount } =
        yield* Effect.promise(() => createController());

      yield* controller.commitProviderKey('openai', 'sk-xxxxxx');

      assert.equal(yield* secrets.get('apiKey.openai'), undefined);
      assert.equal(refreshCount(), 0);
      assert.match(failures[0] ?? '', /Failed to set OpenAI API key/);
      assert.match(failures[0] ?? '', /looks like a placeholder/);
    }),
  );

  it.effect(
    'removes provider keys after confirmation and refreshes dependent state',
    () =>
      Effect.gen(function* () {
        const { controller, deleted, refreshCount, hosts } =
          yield* Effect.promise(() => createController());

        yield* controller.removeProviderKey('openai');

        assert.deepEqual(deleted, ['apiKey.openai']);
        assert.equal(refreshCount(), 1);
        assert.equal(
          hosts.prompt.confirms[0]?.message,
          'Remove the OpenAI API key? This cannot be undone.',
        );
        assert.equal(hosts.prompt.confirms[0]?.options?.modal, false);
        assert.equal(
          hosts.prompt.messages.at(-1)?.message,
          'OpenAI API key has been removed',
        );
      }),
  );

  it.effect('does nothing when provider key removal is not confirmed', () =>
    Effect.gen(function* () {
      const { controller, deleted, refreshCount, hosts } =
        yield* Effect.promise(() =>
          createController({
            confirmResponses: [false],
          }),
        );

      yield* controller.removeProviderKey('openai');

      assert.deepEqual(deleted, []);
      assert.equal(refreshCount(), 0);
      assert.equal(hosts.prompt.messages.length, 0);
    }),
  );

  it.effect('commits a provider key without prompting for input', () =>
    Effect.gen(function* () {
      const { controller, hosts, secrets, refreshCount } =
        yield* Effect.promise(() => createController());

      yield* controller.commitProviderKey('openai', '  sk-direct-secret  ');

      assert.equal(yield* secrets.get('apiKey.openai'), 'sk-direct-secret');
      assert.equal(hosts.prompt.inputs.length, 0);
      assert.equal(refreshCount(), 1);
      assert.equal(
        hosts.prompt.messages.at(-1)?.message,
        'OpenAI API key has been set',
      );
    }),
  );

  it.effect('reports an empty provider key instead of storing it', () =>
    Effect.gen(function* () {
      const { controller, secrets, failures, refreshCount, hosts } =
        yield* Effect.promise(() => createController());

      yield* controller.commitProviderKey('openai', '');

      assert.equal(yield* secrets.get('apiKey.openai'), undefined);
      assert.equal(refreshCount(), 0);
      assert.equal(hosts.prompt.messages.length, 0);
      assert.match(failures[0] ?? '', /empty/);
    }),
  );

  it.effect('does not refresh when secret storage fails', () =>
    Effect.gen(function* () {
      const error = new Error('write failed');
      const { controller, refreshCount, failures } = yield* Effect.promise(() =>
        createController({
          inputResponses: ['sk-real-openai-key'],
          setError: error,
        }),
      );

      yield* controller.setProviderKey('openai');

      assert.match(failures[0] ?? '', /Failed to set OpenAI API key/);
      assert.equal(refreshCount(), 0);
    }),
  );

  it.effect('does not refresh when secret deletion fails', () =>
    Effect.gen(function* () {
      const error = new Error('delete failed');
      const { controller, refreshCount, deleted, failures } =
        yield* Effect.promise(() => createController({ deleteError: error }));

      yield* controller.removeProviderKey('openai');

      assert.match(failures[0] ?? '', /Failed to remove OpenAI API key/);
      assert.deepEqual(deleted, []);
      assert.equal(refreshCount(), 0);
    }),
  );

  // Regression pin: `Effect.exit` absorbs an interruption the same way it
  // absorbs a failure, so a cancelled write used to tell the user the key
  // could not be set — over a credential the store's uninterruptible commit
  // may already have written.
  it.effect(
    'propagates interruption instead of reporting a cancelled write',
    () =>
      Effect.gen(function* () {
        const { controller, secrets, failures, refreshCount } =
          yield* Effect.promise(() =>
            createController({ inputResponses: ['sk-real-openai-key'] }),
          );
        secrets.set = () => Effect.interrupt;

        const exit = yield* Effect.exit(controller.setProviderKey('openai'));

        assert.deepEqual(
          {
            interrupted:
              Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause),
            failures,
            refreshes: refreshCount(),
          },
          { interrupted: true, failures: [], refreshes: 0 },
        );
      }),
  );
});
