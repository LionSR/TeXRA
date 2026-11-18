import { it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { describe, expect } from 'vitest';

import { AppSignals } from '@texra-ai/harness/plugins';
import {
  SubscriptionAccounts,
  type SubscriptionDeviceCodePrompt,
} from '@texra-ai/llm/node';
import { subscriptionProvider } from '@texra/controllers/modelAccess/subscriptionProviders';
import { HostFailed } from '@texra/hosts/uiHosts';
import { noHttpClientLayer } from '@test/support/fetchTestUtils';
import { makeFakeSettingsStores } from '@test/support/settingsStoresFake';

describe('subscription sign-in', () => {
  // A host that could not open the browser reports it with `HostFailed`;
  // the sign-in, not the host, decides that a device code follows.
  it.effect(
    'goes on with a device code when the host cannot open the browser',
    () => {
      const transports: string[] = [];
      const account = {
        signInWithBrowser: (
          openBrowser: (url: string) => Effect.Effect<void, Error>,
        ) =>
          openBrowser('http://127.0.0.1:56121/callback?code=one-time').pipe(
            Effect.andThen(() => {
              transports.push('browser');
              return Effect.die('the callback wait was reached');
            }),
          ),
        signInWithDeviceCode: (
          onPrompt: (
            prompt: SubscriptionDeviceCodePrompt,
          ) => Effect.Effect<void>,
        ) =>
          onPrompt({
            userCode: 'ABCD-EFGH',
            verificationUrl: 'https://accounts.example/device',
          }).pipe(
            Effect.map(() => {
              transports.push('device');
              return { email: 'person@example.com', accountId: null };
            }),
          ),
      };
      const accounts = Layer.succeed(SubscriptionAccounts)(
        // cast: the sign-in reads only the two transports of its account.
        {
          'xai-subscription': account,
        } as unknown as SubscriptionAccounts['Service'],
      );
      return Effect.gen(function* () {
        const signedIn = yield* subscriptionProvider('grok').signIn({
          transport: 'auto',
          stores: makeFakeSettingsStores().stores,
          present: {
            presentDeviceCode: () => Effect.void,
            presentSignInUrl: () =>
              Effect.fail(
                new HostFailed({
                  member: 'openExternal',
                  message: 'No browser would open the sign-in link.',
                  cause: undefined,
                }),
              ),
          },
        });
        expect(transports).toEqual(['device']);
        expect(signedIn.signedIn).toBe(true);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(accounts, AppSignals.layer, noHttpClientLayer),
        ),
      );
    },
  );
});
