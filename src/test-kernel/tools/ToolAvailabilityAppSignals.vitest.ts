// Third-party imports
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import { it } from '@effect/vitest';
import {
  Context,
  Effect,
  Exit,
  Fiber,
  Layer,
  Scope,
  Stream,
  SubscriptionRef,
} from 'effect';
import { afterEach, describe, expect, vi } from 'vitest';

import type { ConfigProvider } from '@platform/interfaces';
import { Secrets, type PlatformSecrets } from '@platform/secrets';
import { testHttpClientLayer } from '@test/support/fetchTestUtils';
import { nodeSpawnerLayer } from '@test/support/childProcessTestLayer';
import type { ToolProbeInputs } from '@tools/toolProbes';
import { LeanLanguageServices } from '@tools/lean/leanLanguageServices';
import { SetupPlatform } from '@tools/setup/platform';
import { ToolAvailability } from '@tools/toolAvailabilityService';
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
  SetupPlatform.layer(createFakeSetupPlatform()),
  // The mocked plugins declare no Lean plugin, so nothing here reads the port.
  Layer.mock(LeanLanguageServices, { listServers: () => [] }),
  testHttpClientLayer,
  nodeSpawnerLayer,
  NodeFileSystem.layer,
);

/** The process's availability service over the (mocked) manifest this test
 *  registered, as a composition root builds it. */
const availabilityService = Effect.gen(function* () {
  const { toolAvailabilityLayer } = yield* Effect.promise(
    () => import('@tools/toolAvailability'),
  );
  const context = yield* Layer.build(toolAvailabilityLayer);
  return Context.get(context, ToolAvailability);
});

afterEach(() => {
  vi.doUnmock('@tools/plugins');
  vi.resetModules();
});

describe('tool availability service', () => {
  it.effect(
    're-probes every open workspace when a key a plugin declares changes',
    () =>
      Effect.gen(function* () {
        const probedRoots: (string | undefined)[] = [];
        vi.doMock('@tools/plugins', () => ({
          TOOL_PLUGINS: [
            {
              id: 'token-tool',
              toolNames: ['token'],
              name: 'Token tool',
              category: 'ai-agents',
              availability: {
                reprobeOnSecrets: ['token.key'],
                probe: vi.fn(({ workspace }: ToolProbeInputs) =>
                  Effect.sync(() => probedRoots.push(workspace)),
                ),
                check: vi.fn(() => Effect.succeed(true)),
              },
            },
          ],
        }));
        const sessionGraph = yield* Effect.promise(
          () => import('@agent/runtime/sessionGraph'),
        );
        const { emitAppSignal } = yield* Effect.promise(
          () => import('@eventBus/AppSignals'),
        );
        const { reprobeOnCredentialChange } = yield* Effect.promise(
          () => import('@tools/credentialReprobe'),
        );
        const availability = yield* availabilityService;
        const session = (workspace: string | undefined) => ({
          roots: { ...probeInputs, workspace },
        });
        // Two projects plus the no-workspace session; the second session on
        // `/a` shares its results, so it is probed once.
        const sessions = [
          session('/a'),
          session('/a'),
          session('/b'),
          session(undefined),
        ];
        sessionGraph.initSessionOwner({
          list: () => Effect.succeed(sessions),
        } as never);
        // Each session holds its roots, which probes them once on open.
        for (const { roots } of sessions) yield* availability.hold(roots);
        const probedAll = SubscriptionRef.changes(availability.results).pipe(
          Stream.filter(() => probedRoots.length === 3),
          Stream.runHead,
        );
        yield* probedAll;
        probedRoots.length = 0;
        const reprobe = yield* Effect.forkChild(
          reprobeOnCredentialChange.pipe(
            Effect.provideService(ToolAvailability, availability),
          ),
        );
        // The re-prober registers on its own fiber, one fork deeper, before
        // the store announces anything.
        yield* Effect.repeat(Effect.yieldNow, { times: 3 });

        emitAppSignal('credentialChanged', { key: 'unrelated.key' });
        emitAppSignal('credentialChanged', { key: 'token.key' });

        yield* probedAll;
        expect(probedRoots.toSorted()).toEqual(['/a', '/b', undefined]);
        sessionGraph.initSessionOwner(undefined);
        yield* Fiber.interrupt(reprobe);
      }).pipe(Effect.provide(probeServices)),
  );

  it.effect(
    're-probes for a caller that joins before the probe fiber starts',
    () =>
      Effect.gen(function* () {
        const check = vi.fn(() => Effect.succeed(true));
        vi.doMock('@tools/plugins', () => ({
          TOOL_PLUGINS: [
            {
              id: 'probed-tool',
              toolNames: ['probed'],
              name: 'Probed tool',
              category: 'ai-agents',
              availability: { check },
            },
          ],
        }));
        const availability = yield* availabilityService;
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
        vi.doMock('@tools/plugins', () => ({
          TOOL_PLUGINS: [
            {
              id: 'present-tool',
              toolNames: ['present'],
              name: 'Present tool',
              category: 'ai-agents',
              availability: {
                check: vi.fn(() => Effect.succeed(true)),
              },
            },
            {
              id: 'missing-tool',
              toolNames: ['missing'],
              name: 'Missing tool',
              category: 'ai-agents',
              toggleable: true,
              availability: {
                check: vi.fn(() => Effect.succeed(false)),
              },
            },
          ],
        }));
        const availability = yield* availabilityService;
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
        vi.doMock('@tools/plugins', () => ({
          TOOL_PLUGINS: [
            {
              id: 'broken-probe',
              toolNames: ['broken'],
              name: 'Broken probe',
              category: 'ai-agents',
              availability: {
                probe: vi.fn(() =>
                  Effect.fail(new Error('invalid local configuration')),
                ),
                check: vi.fn(() => Effect.succeed(true)),
                statusLabel: vi.fn(() => Effect.succeed('Needs setup')),
              },
            },
            {
              id: 'broken-detail',
              toolNames: ['present'],
              name: 'Broken detail',
              category: 'ai-agents',
              availability: {
                check: vi.fn(() => Effect.succeed(true)),
                detailCheck: vi.fn(() =>
                  Effect.fail(new Error('status command crashed')),
                ),
              },
            },
          ],
        }));
        const availability = yield* availabilityService;

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
        ]);
      }).pipe(Effect.provide(probeServices)),
  );
});
