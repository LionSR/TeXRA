// Third-party imports
import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { afterEach, describe, expect, vi } from 'vitest';

afterEach(() => {
  vi.doUnmock('@tools/externalToolDefs');
  vi.resetModules();
});

describe('tool availability app signals', () => {
  it.effect('emits toolAvailabilityChanged after a refresh', () =>
    Effect.gen(function* () {
      vi.doMock('@tools/externalToolDefs', () => ({
        EXTERNAL_TOOL_DEFS: [
          {
            id: 'test-tool',
            tools: [],
            name: 'Test tool',
            category: 'ai-agents',
            check: vi.fn(() => Effect.succeed(true)),
          },
        ],
      }));
      const { appSignals } = yield* Effect.promise(
        () => import('@eventBus/AppSignals'),
      );
      const { refreshToolAvailability } = yield* Effect.promise(
        () => import('@tools/toolAvailability'),
      );
      const events: undefined[] = [];
      const dispose = appSignals.on('toolAvailabilityChanged', (payload) => {
        events.push(payload);
      });

      try {
        yield* refreshToolAvailability();

        expect(events).toEqual([undefined]);
      } finally {
        dispose();
      }
    }),
  );

  it.effect(
    'derives unavailable tool names from the last probe results, with no cache to refresh',
    () =>
      Effect.gen(function* () {
        vi.doMock('@tools/externalToolDefs', () => ({
          EXTERNAL_TOOL_DEFS: [
            {
              id: 'present-tool',
              tools: ['present'],
              name: 'Present tool',
              category: 'ai-agents',
              check: vi.fn(() => Effect.succeed(true)),
            },
            {
              id: 'missing-tool',
              tools: ['missing'],
              name: 'Missing tool',
              category: 'ai-agents',
              toggleable: true,
              check: vi.fn(() => Effect.succeed(false)),
            },
          ],
        }));
        const { getUnavailableToolNamesCached, runExternalToolChecks } =
          yield* Effect.promise(() => import('@tools/toolAvailability'));

        expect([...getUnavailableToolNamesCached()]).toEqual([]);

        yield* runExternalToolChecks();

        // Toggling a tool on or off never changes this set — it reports missing
        // external dependencies only — so there is nothing to rebuild after a
        // toggle, which is why the availability answer is derived on read.
        expect([...getUnavailableToolNamesCached()]).toEqual(['missing']);
      }),
  );

  it.effect(
    'distinguishes failed probes from missing tools without hiding optional-status failures',
    () =>
      Effect.gen(function* () {
        vi.doMock('@tools/externalToolDefs', () => ({
          EXTERNAL_TOOL_DEFS: [
            {
              id: 'broken-probe',
              tools: ['broken'],
              name: 'Broken probe',
              category: 'ai-agents',
              probe: vi.fn(() =>
                Effect.fail(new Error('invalid local configuration')),
              ),
              check: vi.fn(() => Effect.succeed(true)),
              statusLabel: vi.fn(() => Effect.succeed('Needs setup')),
            },
            {
              id: 'broken-detail',
              tools: ['present'],
              name: 'Broken detail',
              category: 'ai-agents',
              check: vi.fn(() => Effect.succeed(true)),
              detailCheck: vi.fn(() =>
                Effect.fail(new Error('status command crashed')),
              ),
            },
          ],
        }));
        const { runExternalToolChecks } = yield* Effect.promise(
          () => import('@tools/toolAvailability'),
        );

        expect(yield* runExternalToolChecks()).toEqual([
          expect.objectContaining({
            id: 'broken-probe',
            status: 'unknown',
            detected: null,
            statusLabel: undefined,
            statusDetail:
              'Availability check failed: invalid local configuration',
          }),
          expect.objectContaining({
            id: 'broken-detail',
            status: 'available',
            detected: true,
            statusDetail: undefined,
          }),
        ]);
      }),
  );
});
