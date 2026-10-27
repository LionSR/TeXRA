import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { describe, expect } from 'vitest';

import { apiKeySecretName, SecretsFailed } from '@texra-ai/llm';
import { FakeSecrets } from '@test/support/FakePlatform';
import { makeFakeSettingsStores } from '@test/support/settingsStoresFake';
import { withEnv } from '@test/support/testEnv';
import { resolveSetupLaunchModel } from '@texra/model/setupCredentialAccess';

/** A key store whose Anthropic key cannot be read; every other key is absent. */
class UnreadableAnthropicKey extends FakeSecrets {
  override get(key: string) {
    return key === apiKeySecretName('anthropic')
      ? Effect.fail(
          new SecretsFailed({
            reason: 'io',
            operation: 'get',
            message: 'keychain locked',
            key,
          }),
        )
      : super.get(key);
  }
}

describe('resolveSetupLaunchModel', () => {
  // An unreadable key is neither a credential nor its absence: answering
  // "no model" would send the user to add a key they already have.
  it.effect(
    'fails rather than answering "no model" when a key could not be read',
    () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          resolveSetupLaunchModel(
            makeFakeSettingsStores().stores,
            new UnreadableAnthropicKey(),
          ),
        );

        expect(error).toMatchObject({
          _tag: 'StateReadFailed',
          key: 'anthropic',
        });
      }).pipe(withEnv({})),
  );
});
