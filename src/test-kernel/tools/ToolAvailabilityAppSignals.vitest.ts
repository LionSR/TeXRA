// Third-party imports
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import { it } from '@effect/vitest';
import {
  Context,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Scope,
  Stream,
  SubscriptionRef,
} from 'effect';
import { afterEach, describe, expect, vi } from 'vitest';

import type { RuntimeTool as ITool } from '@agent/runtime/ToolServices';
import type { ConfigProvider } from '@platform/interfaces';
import { Secrets, type PlatformSecrets } from '@platform/secrets';
import { testHttpClientLayer } from '@test/support/fetchTestUtils';
import { nodeSpawnerLayer } from '@test/support/childProcessTestLayer';
import { LeanLanguageServices } from '@texra/tools/lean/leanLanguageServices';
import type { Plugin } from '@tools/plugins';
import type { ToolProbeInputs } from '@tools/toolProbes';
import { ToolCatalog } from '@tools/liveTools';
import { ToolRegistry, toolTable } from '@tools/toolTable';
import { ToolAvailability } from '@tools/toolAvailabilityService';

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
  workspace: undefined,
  config: {
    get: unreadConfig,
    update: unreadConfig,
    inspect: unreadConfig,
  } satisfies ConfigProvider,
  host: 'cli',
};

const secretsLayer = Secrets.layer({
  get: unreadSecret,
  set: unreadSecret,
  delete: unreadSecret,
  listStoredKeys: unreadSecret,
} satisfies PlatformSecrets);

/** The services a plugin's availability callbacks may read. */
const probeServices = Layer.mergeAll(
  secretsLayer,
  // The mocked plugins declare no Lean plugin, so nothing here reads the port.
  Layer.mock(LeanLanguageServices, { listServers: () => [] }),
  testHttpClientLayer,
  nodeSpawnerLayer,
  NodeFileSystem.layer,
);

/** Tools under `names`, which the availability service only lists. */
const named = (...names: string[]): Record<string, ITool> =>
  Object.fromEntries(
    names.map((name) => [
      name,
      {
        definition: { name, description: name, parameters: {} },
        call: vi.fn(),
      },
    ]),
  );

/** The process's availability service over `plugins`, as a composition root
 *  builds it. */
const availabilityService = (plugins: readonly Plugin[]) =>
  Effect.gen(function* () {
    const { toolAvailabilityLayer } = yield* Effect.promise(
      () => import('@tools/toolAvailability'),
    );
    const context = yield* Layer.build(
      toolAvailabilityLayer.pipe(
        Layer.provide(
          Layer.merge(
            Layer.succeed(ToolRegistry)(toolTable(plugins)),
            // No plugin layer is up: each probe runs on the process services.
            Layer.mock(ToolCatalog, {
              processServices: () => Effect.succeed(Option.none()),
            }),
          ),
        ),
      ),
    );
    return Context.get(context, ToolAvailability);
  });

afterEach(() => {
  vi.resetModules();
});

describe('tool availability service', () => {
  it.effect(
    're-probes every open workspace when a key a plugin declares changes',
    () =>
      Effect.gen(function* () {
        const probedRoots: (string | undefined)[] = [];
        const plugins: readonly Plugin[] = [
          {
            id: 'token-tool',
            tools: named('token'),
            availability: {
              reprobeOnSecrets: ['token.key'],
              probe: vi.fn(({ workspace }: ToolProbeInputs) =>
                Effect.sync(() => probedRoots.push(workspace)),
              ),
              check: vi.fn(() => Effect.succeed(true)),
            },
          },
        ];
        const { emitAppSignal } = yield* Effect.promise(
          () => import('@eventBus/AppSignals'),
        );
        const availability = yield* availabilityService(plugins);
        const roots = (workspace: string | undefined) => ({
          ...probeInputs,
          workspace,
        });
        // Two projects plus the no-workspace session; the second session on
        // `/a` shares its results, so it is probed once.
        const sessions = [
          roots('/a'),
          roots('/a'),
          roots('/b'),
          roots(undefined),
        ];
        // Each session holds its roots, which probes them once on open.
        for (const held of sessions) yield* availability.hold(held);
        const probedAll = SubscriptionRef.changes(availability.results).pipe(
          Stream.filter(() => probedRoots.length === 3),
          Stream.runHead,
        );
        yield* probedAll;
        probedRoots.length = 0;

        emitAppSignal('credentialChanged', { key: 'unrelated.key' });
        emitAppSignal('credentialChanged', { key: 'token.key' });

        yield* probedAll;
        expect(probedRoots.toSorted()).toEqual(['/a', '/b', undefined]);
      }).pipe(Effect.provide(probeServices)),
  );

  it.effect(
    're-probes for a caller that joins before the probe fiber starts',
    () =>
      Effect.gen(function* () {
        const check = vi.fn(() => Effect.succeed(true));
        const plugins: readonly Plugin[] = [
          {
            id: 'probed-tool',
            tools: named('probed'),
            availability: { check },
          },
        ];
        const availability = yield* availabilityService(plugins);
        // The first caller claims the slot and forks the probe; the second
        // joins before that fiber's first step and asks for a rerun.
        const first = yield* Effect.forkChild(
          availability.refresh(probeInputs),
          { startImmediately: true },
        );
        const second = yield* Effect.forkChild(
          availability.refresh(probeInputs),
          { startImmediately: true },
        );
        yield* Fiber.join(first);
        yield* Fiber.join(second);
        expect(check).toHaveBeenCalledTimes(2);
      }).pipe(Effect.provide(probeServices)),
  );

  it.effect(
    'holds each workspace its own results, none before a probe answers',
    () =>
      Effect.gen(function* () {
        const plugins: readonly Plugin[] = [
          {
            id: 'present-tool',
            tools: named('present'),
            availability: {
              check: vi.fn(() => Effect.succeed(true)),
            },
          },
          {
            id: 'missing-tool',
            tools: named('missing'),
            toggle: 'off',
            availability: {
              check: vi.fn(() => Effect.succeed(false)),
            },
          },
        ];
        const availability = yield* availabilityService(plugins);
        const statuses = (root: string | undefined) =>
          Effect.map(SubscriptionRef.get(availability.results), (held) =>
            held.get(root)?.map(({ id, status }) => [id, status]),
          );

        expect(yield* statuses(undefined)).toBeUndefined();

        // A root no session holds is answered, not remembered.
        yield* availability.refresh(probeInputs);
        expect(yield* statuses(undefined)).toBeUndefined();

        const hold = yield* Scope.make();
        yield* availability.hold(probeInputs).pipe(Scope.provide(hold));
        yield* availability.refresh(probeInputs);
        expect(yield* statuses(undefined)).toEqual([
          ['present-tool', 'available'],
          ['missing-tool', 'not-found'],
        ]);
        // The probes read the workspace, so one workspace's results never
        // answer for another's on a multi-project host.
        expect(yield* statuses('/other/project')).toBeUndefined();
        // The last holder leaving drops the root's results.
        yield* Scope.close(hold, Exit.void);
        expect(yield* statuses(undefined)).toBeUndefined();
      }).pipe(Effect.provide(probeServices)),
  );

  it.effect(
    'distinguishes failed probes from missing tools without hiding optional-status failures',
    () =>
      Effect.gen(function* () {
        const plugins: readonly Plugin[] = [
          {
            id: 'broken-probe',
            tools: named('broken'),
            availability: {
              probe: vi.fn(() =>
                Effect.fail(new Error('invalid local configuration') as never),
              ),
              check: vi.fn(() => Effect.succeed(true)),
              statusLabel: vi.fn(() => Effect.succeed('Needs setup')),
            },
          },
          {
            id: 'broken-detail',
            tools: named('present'),
            availability: {
              check: vi.fn(() => Effect.succeed(true)),
              detailCheck: vi.fn(() =>
                Effect.fail(new Error('status command crashed') as never),
              ),
            },
          },
          {
            // A callback that throws, as an eager configuration read can.
            id: 'throwing-probe',
            tools: named('throwing'),
            availability: {
              probe: vi.fn(() => {
                throw new Error('config read threw');
              }),
              check: vi.fn(() => Effect.succeed(true)),
            },
          },
        ];
        const availability = yield* availabilityService(plugins);
        const throwing = expect.objectContaining({
          id: 'throwing-probe',
          status: 'unknown',
          statusDetail: 'Availability check failed: config read threw',
        });

        // A defect is reported, not fatal: the root's next check probes
        // again rather than joining a dead fiber.
        for (const _ of [1, 2])
          expect(yield* availability.refresh(probeInputs)).toContainEqual(
            throwing,
          );
        expect(yield* availability.refresh(probeInputs)).toEqual([
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
          throwing,
        ]);
      }).pipe(Effect.provide(probeServices)),
  );
});
