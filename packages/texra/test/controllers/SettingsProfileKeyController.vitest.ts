import { strict as assert } from 'node:assert';

import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { describe } from 'vitest';

import { Secrets } from '@texra-ai/harness/plugins';
import { createFakeUIHosts } from '@test/support/fakeUiPorts';
import { FakeSecrets } from '@test/support/FakePlatform';
import { makeFakeSettingsStores } from '@test/support/settingsStoresFake';
import { commitProviderKey } from '@texra/controllers/settingsView/providerKeyActions';
import { HARNESS_APP } from '@test/support/FakePlatform';

describe('provider key actions', () => {
  // Regression pin: the placeholder guard used to live only in the CLI, so the
  // graphical hosts happily wrote `sk-xxxxxx` into the secret store.
  it.effect('reports a placeholder key instead of storing it', () =>
    Effect.gen(function* () {
      const secrets = new FakeSecrets();
      const failure = yield* Effect.flip(
        commitProviderKey(
          createFakeUIHosts({ confirmResponses: [true] }).dialogs,
          makeFakeSettingsStores().stores,
          'openai',
          'sk-xxxxxx',
        ),
      ).pipe(Effect.provide(Secrets.layer(secrets, HARNESS_APP.client)));

      assert.equal(yield* secrets.get('apiKey.openai'), undefined);
      assert.match(String(failure.cause), /looks like a placeholder/);
    }),
  );
});
