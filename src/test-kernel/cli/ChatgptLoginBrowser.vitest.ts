import { it } from '@effect/vitest';
import { Deferred, Effect, Exit, Fiber, Layer } from 'effect';
import { afterEach, describe, expect, vi } from 'vitest';
import { Secrets } from '@platform/secrets';
import { FakeSecrets } from '@test/support/FakePlatform';
import { testHttpClientLayer } from '@test/support/fetchTestUtils';

import { scriptedSpawnerLayer } from '@test/support/childProcessTestLayer';

const mocks = vi.hoisted(() => ({
  codexCoordinator: vi.fn(() => ({})),
  loginWithDeviceCode: vi.fn(),
  loginWithLoopback: vi.fn(),
  tryOpenBrowser: vi.fn(),
}));

vi.mock('@auth/codex', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@auth/codex')>()),
  codexCoordinator: mocks.codexCoordinator,
  loginWithDeviceCode: mocks.loginWithDeviceCode,
  loginWithLoopback: mocks.loginWithLoopback,
}));

vi.mock('@cli/runtime/browser', () => ({
  tryOpenBrowser: mocks.tryOpenBrowser,
}));

const { signInCliSubscription } =
  await import('@cli/runtime/subscriptionLogin');
type CliSubscriptionLoginOptions =
  import('@cli/runtime/subscriptionLogin').CliSubscriptionLoginOptions;

// What the host root provides the flow.
const signInServices = Layer.mergeAll(
  Secrets.layer(new FakeSecrets()),
  testHttpClientLayer,
  // The browser launch is mocked, so nothing is spawned.
  scriptedSpawnerLayer(() => ({})).layer,
);
/** Run the program as the login command does, on the test's own fiber. */
const signInCliChatGpt = (
  init: { device: boolean; noBrowser: boolean },
  options: CliSubscriptionLoginOptions,
) =>
  signInCliSubscription('chatgpt', init, options).pipe(
    Effect.provide(signInServices),
  );

function loopbackSession() {
  return {
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    expiresAtMs: Date.now() + 60_000,
  };
}

/** Drive the loopback transport through the sign-in URL it would publish. */
function publishLoopbackUrl(url: string): void {
  mocks.loginWithLoopback.mockImplementation(
    ({ openBrowser }: { openBrowser: (url: string) => Effect.Effect<void> }) =>
      openBrowser(url).pipe(Effect.as(loopbackSession())),
  );
}

const runSignIn = (url: string, noBrowser = false) =>
  Effect.gen(function* () {
    publishLoopbackUrl(url);
    const progress: string[] = [];
    yield* signInCliChatGpt(
      { device: false, noBrowser },
      // Only the instructions are copyable: a panel that shows its latest
      // status line keeps the copyable URL on screen beneath it.
      {
        writeProgress: (message, options) => {
          progress.push(options?.copyable ? `[copyable] ${message}` : message);
        },
      },
    );
    return progress;
  });

describe('signInCliSubscription (ChatGPT) browser choice', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it.effect('prints the URL once when the browser fails to launch', () =>
    Effect.gen(function* () {
      mocks.tryOpenBrowser.mockReturnValue(Effect.succeed(false));

      const progress = yield* runSignIn(
        'https://auth.openai.com/authorize?x=2',
      );

      expect(progress).toEqual([
        '[copyable] ChatGPT sign-in URL:\nhttps://auth.openai.com/authorize?x=2',
        'Browser launch in progress...',
        'Automatic browser launch failed; open the sign-in URL above.',
      ]);
    }),
  );

  it.effect(
    'skips the launch attempt and prints the URL with --no-browser',
    () =>
      Effect.gen(function* () {
        const progress = yield* runSignIn(
          'https://auth.openai.com/authorize?x=3',
          true,
        );

        expect(mocks.tryOpenBrowser).not.toHaveBeenCalled();
        expect(progress).toEqual([
          '[copyable] ChatGPT sign-in URL:\nhttps://auth.openai.com/authorize?x=3',
        ]);
      }),
  );

  it.effect('publishes the URL before a slow browser launcher returns', () =>
    Effect.gen(function* () {
      const launch = yield* Deferred.make<boolean>();
      mocks.tryOpenBrowser.mockReturnValue(Deferred.await(launch));
      publishLoopbackUrl('https://auth.openai.com/authorize?x=slow');
      const progress: string[] = [];

      const published = yield* Deferred.make<string>();
      const signIn = yield* Effect.forkChild(
        signInCliChatGpt(
          { device: false, noBrowser: false },
          {
            writeProgress: (message) => {
              progress.push(message);
              if (progress.length === 1) {
                Deferred.doneUnsafe(published, Effect.succeed(message));
              }
            },
          },
        ),
      );

      expect(yield* Deferred.await(published)).toContain(
        'https://auth.openai.com/authorize?x=slow',
      );
      yield* Deferred.succeed(launch, true);
      yield* Fiber.join(signIn);
    }),
  );

  it.effect(
    'forwards interactive cancellation to both ChatGPT transports',
    () =>
      Effect.gen(function* () {
        const interrupted: string[] = [];
        const pending = (transport: string, started: Deferred.Deferred<void>) =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.onInterrupt(() =>
              Effect.sync(() => {
                interrupted.push(transport);
              }),
            ),
          );
        const options = { writeProgress: vi.fn() };

        for (const init of [
          { device: false, noBrowser: true },
          { device: true, noBrowser: false },
        ]) {
          const started = yield* Deferred.make<void>();
          mocks.loginWithLoopback.mockReturnValue(pending('loopback', started));
          mocks.loginWithDeviceCode.mockReturnValue(pending('device', started));
          const fiber = yield* Effect.forkChild(
            signInCliChatGpt(init, options),
          );
          yield* Deferred.await(started);
          yield* Fiber.interrupt(fiber);
          const exit = yield* Fiber.await(fiber);
          expect(Exit.isFailure(exit) && Exit.hasInterrupts(exit)).toBe(true);
        }

        expect(interrupted).toEqual(['loopback', 'device']);
      }),
  );
});
