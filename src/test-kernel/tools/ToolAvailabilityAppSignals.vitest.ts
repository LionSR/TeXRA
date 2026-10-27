// Third-party imports
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import { it } from '@effect/vitest';
import {
  Context,
  Effect,
  Layer,
  Option,
  Stream,
  SubscriptionRef,
} from 'effect';
import { afterEach, describe, expect, vi } from 'vitest';

import type {
  PluginToolServices,
  RuntimeTool,
} from '@agent/runtime/ToolServices';
import type { ConfigProvider } from '@platform/interfaces';
import { Secrets, type PlatformSecrets } from '@platform/secrets';
import { testHttpClientLayer } from '@test/support/fetchTestUtils';
import { nodeSpawnerLayer } from '@test/support/childProcessTestLayer';
import { TEXRA_SETTINGS } from '@texra/shared/settingsView/texraSettings';
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
    catalog: TEXRA_SETTINGS,
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
const named = (
  ...names: string[]
): Record<string, RuntimeTool<Error, PluginToolServices>> =>
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
});
