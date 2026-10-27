import { strict as assert } from 'node:assert';

import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { describe } from 'vitest';

import { Secrets } from '@platform/secrets';
import { createFakeUIHosts } from '@test/support/FakeHosts';
import { FakeSecrets } from '@test/support/FakePlatform';
import { makeFakeSettingsStores } from '@test/support/settingsStoresFake';
import { SettingsProfileKeyController } from '@texra/controllers/settingsView/SettingsProfileKeyController';

describe('SettingsProfileKeyController', () => {
  // Regression pin: the placeholder guard used to live only in the CLI, so the
  // graphical hosts happily wrote `sk-xxxxxx` into the secret store.
  it.effect('reports a placeholder key instead of storing it', () =>
    Effect.gen(function* () {
      const secrets = new FakeSecrets();
      const controller = new SettingsProfileKeyController({
        prompt: createFakeUIHosts({ confirmResponses: [true] }).prompt,
        stores: makeFakeSettingsStores().stores,
      });

      const failure = yield* Effect.flip(
        controller.commitProviderKey('openai', 'sk-xxxxxx'),
      ).pipe(Effect.provide(Secrets.layer(secrets)));

      assert.equal(yield* secrets.get('apiKey.openai'), undefined);
      assert.match(String(failure.cause), /looks like a placeholder/);
    }),
  );
});
