// Test composition imports

// Local imports
import '@test/support/defaultSessionTestSetup';

// Third-party imports
import { it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { afterEach, describe, expect, vi } from 'vitest';

// Local imports
import { effectDiagnosticsLayer } from '@logger/effectDiagnostics';
import { setLogSink } from '@logger/logSink';
import { Secrets } from '@platform/secrets';
import type { RunId } from '@shared/schemas';
import { testHttpClientLayer } from '@test/support/fetchTestUtils';
import { fakeHostSecrets } from '@test/support/setupPlatform';
import { testRuntime } from '@test/support/testProcessRuntime';

// Test support imports
import { captureLogEntries } from '@test/support/logSinkCapture';
import type { PollEventListener } from '@texra/tools/github/PollingSourceBase';
import {
  RunSubscriptionRegistry,
  type RunSubscriptionRegistryOptions,
} from '@texra/tools/github/RunSubscriptionRegistry';

// Local file imports
import type { RunInbox } from '@texra-ai/harness/plugins';

/** What a source's `subscribe` reads: the token store and the HTTP client. */
const githubServices = Layer.merge(
  Secrets.layer(fakeHostSecrets),
  testHttpClientLayer,
);

/** A run's input that records what the registry sends it. */
function testInbox(
  send: RunInbox['send'] = () => Effect.succeed({ status: 'sent' as const }),
) {
  return { send: vi.fn(send), onClosed: () => () => {} } satisfies RunInbox;
}

function createTestRegistry(
  source: RegistryTestSource,
  overrides: Partial<RunSubscriptionRegistryOptions<string, string>> = {},
): RunSubscriptionRegistry<string, string> {
  return new RunSubscriptionRegistry<string, string>({
    name: 'test subscriptions',
    source,
    keyOf: (input) => input,
    ...overrides,
  });
}

class RegistryTestSource {
  private readonly keys = new Set<string>();
  private readonly keyListeners = new Set<(keys: readonly string[]) => void>();
  private readonly onEventByKey = new Map<string, PollEventListener>();

  activeKeys(): readonly string[] {
    return [...this.keys];
  }

  has(key: string): boolean {
    return this.keys.has(key);
  }

  keyListenerCount(): number {
    return this.keyListeners.size;
  }

  onKeysChanged(listener: (keys: readonly string[]) => void): {
    dispose(): void;
  } {
    this.keyListeners.add(listener);
    return { dispose: () => this.keyListeners.delete(listener) };
  }

  subscribe(
    input: string,
    onEvent: PollEventListener,
  ): Effect.Effect<{ dispose(): void }> {
    return Effect.suspend(() => {
      this.keys.add(input);
      this.onEventByKey.set(input, onEvent);
      this.emitKeysChanged();
      return Effect.succeed({
        dispose: () => {
          this.keys.delete(input);
          this.onEventByKey.delete(input);
          this.emitKeysChanged();
        },
      });
    });
  }

  /**
   * Deliver one event the way `PollingSourceBase.emitToListener` does: the
   * listener builds its delivery program on this turn, then the program runs.
   * Awaiting the program keeps the assertions below deterministic, and the
   * diagnostics logger routes its warnings to the log sink as a host's does.
   */
  async emit(input: string, text: string): Promise<void> {
    const listener = this.onEventByKey.get(input);
    if (listener) {
      await testRuntime().runPromise(
        listener(text).pipe(Effect.provide(effectDiagnosticsLayer('Trace'))),
      );
    }
  }

  private emitKeysChanged(): void {
    const keys = [...this.keys];
    for (const listener of this.keyListeners) listener(keys);
  }
}

describe('GitHub subscription app signals and follow-ups', () => {
  afterEach(() => {
    setLogSink(null);
  });

  it.effect('dispose releases every binding and the source-key listener', () =>
    Effect.gen(function* () {
      const source = new RegistryTestSource();
      const registry = createTestRegistry(source);

      yield* registry
        .bind('stream-a' as RunId, 'owner/repo', testInbox())
        .pipe(Effect.provide(githubServices));
      expect(source.keyListenerCount()).toBe(1);

      registry.dispose();

      expect(source.activeKeys()).toEqual([]);
      expect(source.keyListenerCount()).toBe(0);
      expect(registry.list(['owner/repo'])).toEqual([
        { key: 'owner/repo', runIds: [] },
      ]);
    }),
  );

  it.effect(
    'rebinds an existing subscription to the input that rebound it',
    () =>
      Effect.gen(function* () {
        const runId = 'stream-a' as RunId;
        const source = new RegistryTestSource();
        const first = testInbox();
        const second = testInbox();
        const registry = createTestRegistry(source);

        yield* registry
          .bind(runId, 'owner/repo', first)
          .pipe(Effect.provide(githubServices));
        yield* registry
          .bind(runId, 'owner/repo', second)
          .pipe(Effect.provide(githubServices));

        yield* Effect.promise(() =>
          source.emit('owner/repo', 'new github event'),
        );

        expect(first.send).not.toHaveBeenCalled();
        expect(second.send).toHaveBeenCalledWith(
          {
            text: 'new github event',
            from: { kind: 'notification', source: 'github' },
          },
          { hold: 'generation' },
        );
      }),
  );

  it.effect(
    'warns instead of leaking an unhandled rejection when delivery fails',
    () =>
      Effect.gen(function* () {
        const runId = 'stream-a' as RunId;
        const source = new RegistryTestSource();
        const inbox = testInbox(() =>
          Effect.fail(new Error('delivery failed')),
        );
        const logs = captureLogEntries();
        const registry = createTestRegistry(source);
        const unhandledRejection = vi.fn();
        yield* Effect.addFinalizer(() =>
          Effect.sync(() =>
            process.off('unhandledRejection', unhandledRejection),
          ),
        );

        process.once('unhandledRejection', unhandledRejection);
        yield* registry
          .bind(runId, 'owner/repo', inbox)
          .pipe(Effect.provide(githubServices));

        // emit() awaits the delivery program, so the recovery has run by the
        // time it resolves — no settle-and-hope.
        yield* Effect.promise(() =>
          source.emit('owner/repo', 'new github event'),
        );

        expect(unhandledRejection).not.toHaveBeenCalled();
        const [warning] = logs.at('WARN', 'test subscriptions');
        expect(warning?.message).toBe(
          `Failed to deliver subscription follow-up for owner/repo (run ${runId})`,
        );
        expect(warning?.annotations.data).toContain('delivery failed');
      }),
  );
});
