// Test composition imports

// Third-party imports
import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { afterEach, describe, expect, vi } from 'vitest';

// Local imports

import { createLifecycleHost } from '@platform/defaults/lifecycleHost';
import { SHUTDOWN_PHASE } from '@platform/interfaces';
import { closeSessionOf } from '@test/support/sessionEnd';
import { testDefaultSession } from '@test/support/defaultSessionTestSetup';
import { createTestSession } from '@test/support/sessionTestUtils';
import { registerRuntimeShutdownHandlers } from '@tools/agentCliSessionStores';

describe('agent shutdown', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.effect("drains every live session's background processes once", () =>
    Effect.gen(function* () {
      const firstSession = createTestSession();
      const secondSession = createTestSession();
      yield* Effect.addFinalizer(() =>
        closeSessionOf(firstSession).pipe(
          Effect.andThen(closeSessionOf(secondSession)),
        ),
      );
      const compatibilitySession = testDefaultSession();
      const firstDrain = vi.spyOn(firstSession.runs, 'killBackgroundProcesses');
      const secondDrain = vi.spyOn(
        secondSession.runs,
        'killBackgroundProcesses',
      );
      const compatibilityDrain = vi.spyOn(
        compatibilitySession.runs,
        'killBackgroundProcesses',
      );

      const lifecycle = createLifecycleHost();
      registerRuntimeShutdownHandlers(lifecycle, {
        flushArtifacts: Effect.void,
        releaseSessions: Effect.void,
        disposeRuntime: Effect.void,
      });

      yield* Effect.all([lifecycle.runShutdown, lifecycle.runShutdown], {
        concurrency: 'unbounded',
      });
      yield* lifecycle.runShutdown;

      expect(firstDrain).toHaveBeenCalledOnce();
      expect(secondDrain).toHaveBeenCalledOnce();
      expect(compatibilityDrain).toHaveBeenCalledOnce();
    }),
  );

  it.effect('preserves the shared shutdown order around host hooks', () =>
    Effect.gen(function* () {
      const session = createTestSession();
      yield* Effect.addFinalizer(() => closeSessionOf(session));
      const order: string[] = [];
      vi.spyOn(session.runs, 'killBackgroundProcesses').mockImplementation(
        () => {
          order.push('agent-shutdown');
        },
      );

      const lifecycle = createLifecycleHost();
      registerRuntimeShutdownHandlers(lifecycle, {
        beforeAgentShutdown: [
          Effect.sync(() => {
            order.push('before-agent');
          }),
        ],
        afterAgentShutdown: [
          Effect.sync(() => {
            order.push('after-agent');
          }),
        ],
        flushArtifacts: Effect.sync(() => {
          order.push('flush');
        }),
        afterFlushArtifacts: [
          Effect.sync(() => {
            order.push('after-flush');
          }),
        ],
        afterRunSettlement: [
          Effect.sync(() => {
            order.push('after-settle');
          }),
        ],
        releaseSessions: Effect.sync(() => {
          order.push('release-sessions');
        }),
        disposeRuntime: Effect.sync(() => {
          order.push('dispose-runtime');
        }),
      });
      // An ON handler registered after the host's shutdown order (a view or
      // a polling source) still runs before the process is released.
      lifecycle.onShutdown(
        SHUTDOWN_PHASE.ON,
        Effect.sync(() => {
          order.push('late-on');
        }),
      );

      yield* lifecycle.runShutdown;

      // The session's close is the first ON step, and it is what kills its
      // runs' background processes.
      expect(order).toEqual([
        'before-agent',
        'after-agent',
        'flush',
        'after-flush',
        'agent-shutdown',
        'after-settle',
        'late-on',
        'release-sessions',
        'dispose-runtime',
      ]);
    }),
  );
});
