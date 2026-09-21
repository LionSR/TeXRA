// Third-party imports
import { it } from '@effect/vitest';
import { Effect, Fiber, Layer } from 'effect';
import { afterEach, describe, expect, vi } from 'vitest';

import type { ConfigProvider } from '@platform/interfaces';
import { Secrets, type PlatformSecrets } from '@platform/secrets';
import type { ToolProbeInputs } from '@tools/externalToolDefs';
import { LeanLanguageServices } from '@tools/lean/leanLanguageServices';
import { SetupPlatform } from '@tools/setup/platform';
import { createFakeSetupPlatform } from './setup/fixtures';

/** The mocked tool defs read no secrets, so any call here is a test error. */
const unreadSecret = (): never => {
  throw new Error('The mocked external tool defs must not read secrets.');
};

/** Same for configuration: the mocked defs declare no config-reading probe. */
const unreadConfig = (): never => {
  throw new Error('The mocked external tool defs must not read configuration.');
};

/** The workspace the probes are handed. No mocked def reads it, so its stores
 *  answer nothing. */
const probeInputs: ToolProbeInputs = {
  workspaceRoot: undefined,
  config: {
    get: unreadConfig,
    update: unreadConfig,
    inspect: unreadConfig,
  } satisfies ConfigProvider,
};

const secretsLayer = Secrets.layer({
  get: unreadSecret,
  getStored: unreadSecret,
  set: unreadSecret,
  delete: unreadSecret,
  listStoredKeys: unreadSecret,
  getEnv: unreadSecret,
} satisfies PlatformSecrets);

/** The services a group's availability callbacks may read. */
const probeServices = Layer.mergeAll(
  secretsLayer,
  SetupPlatform.layer(createFakeSetupPlatform()),
  // The mocked defs declare no Lean group, so nothing here reads the port.
  Layer.mock(LeanLanguageServices, { listServers: () => [] }),
);

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
      const { onAppSignal } = yield* Effect.promise(
        () => import('@eventBus/AppSignals'),
      );
      const { refreshToolAvailability } = yield* Effect.promise(
        () => import('@tools/toolAvailability'),
      );
      const events: undefined[] = [];
      // The subscriber drains on its own fiber: the yield lets it register
      // before the probe publishes, and the wait lets the delivery land.
      const fiber = yield* Effect.fork(
        onAppSignal('toolAvailabilityChanged', (payload) => {
          events.push(payload);
        }),
      );
      yield* Effect.yieldNow;

      yield* refreshToolAvailability(probeInputs);

      yield* Effect.promise(() =>
        vi.waitFor(() => expect(events).toEqual([undefined])),
      );
      yield* Fiber.interrupt(fiber);
    }).pipe(Effect.provide(probeServices)),
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

        yield* runExternalToolChecks(probeInputs);

        // Toggling a tool on or off never changes this set — it reports missing
        // external dependencies only — so there is nothing to rebuild after a
        // toggle, which is why the availability answer is derived on read.
        expect([...getUnavailableToolNamesCached()]).toEqual(['missing']);
      }).pipe(Effect.provide(probeServices)),
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

        expect(yield* runExternalToolChecks(probeInputs)).toEqual([
          expect.objectContaining({
            id: 'broken-probe',
            status: 'unknown',
            statusLabel: undefined,
            statusDetail:
              'Availability check failed: invalid local configuration',
          }),
          expect.objectContaining({
            id: 'broken-detail',
            status: 'available',
            statusDetail: undefined,
          }),
        ]);
      }).pipe(Effect.provide(probeServices)),
  );
});
