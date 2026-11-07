import { it, layer } from '@effect/vitest';
import { Context, Effect, Exit, Layer, Scope } from 'effect';
import { afterEach, beforeEach, describe, expect, vi, type Mock } from 'vitest';

import { AGENT_SOURCE } from '@texra-ai/harness/schemas';
import { effectDiagnosticsLayer, setLogSink } from '@texra-ai/harness/node';
import { AppState, UsageLog } from '@texra-ai/harness/host';
import { MemoryConfigProvider } from '@platform/defaults/memoryConfigProvider';
import type { WorkspaceRoots } from '@platform/workspaceRoots';
import { usageAgentName } from '@shared/usageLog';
import {
  usageLogLayer,
  type UsageLogOptions,
} from '@telemetry/UsageLogService';
import {
  jsonResponse,
  testHttpClientLayer,
} from '@test/support/fetchTestUtils';
import { FakeHost } from '@test/support/testKernel';
import {
  TELEMETRY_ENABLED_SETTING,
  TEXRA_SETTINGS,
} from '@texra/shared/settingsView/texraSettings';

function usageEntry(model: string) {
  return {
    model,
    provider: 'openai-responses' as const,
    agentName: 'agent',
    inputTokens: 1,
    outputTokens: 1,
    cost: 0.001,
  };
}

/** The usage endpoint; a case asserts it is never reached. */
function stubBatchFetch(): Mock {
  const fetchMock = vi.fn(async () =>
    jsonResponse({ success: true, accepted: 1 }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('UsageLogService', () => {
  // The service's lifetime is a layer the process runtime builds; a suite
  // owns one scope in its place, and closing it is what the host's runtime
  // disposal does.
  let lifetime: Scope.Closeable | undefined;
  let usageLog: UsageLog['Service'];
  /** Queue one entry, as the invoker's usage report does. */
  const logUsage = (...args: Parameters<UsageLog['Service']['log']>) =>
    Effect.runSync(usageLog.log(...args));

  const stopUsageLog = async (): Promise<void> => {
    const scope = lifetime;
    lifetime = undefined;
    if (scope) await Effect.runPromise(Scope.close(scope, Exit.void));
  };

  /** Start the service over the test host's app state, where the install
   *  id is kept, replacing one already running. */
  const startUsageLog = (config: UsageLogOptions['config']) =>
    Effect.gen(function* () {
      yield* Effect.promise(stopUsageLog);
      const host = yield* FakeHost;
      const scope = Scope.makeUnsafe();
      lifetime = scope;
      const context = yield* Scope.provide(
        Layer.build(
          usageLogLayer({
            version: undefined,
            editorType: undefined,
            config,
          }).pipe(
            Layer.provide(
              Layer.mergeAll(
                // The process runtime's diagnostics, which the service logs
                // through; the fetch each test stubs; and the host's app
                // state.
                effectDiagnosticsLayer('Trace'),
                testHttpClientLayer,
                AppState.layer(host.roots.globalState),
              ),
            ),
          ),
        ),
        scope,
      );
      usageLog = Context.get(context, UsageLog);
    });

  const DEFAULT_CONFIG: UsageLogOptions['config'] = {
    batchSize: 1,
    flushIntervalMs: 60_000,
    enabled: true,
  };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });

  afterEach(async () => {
    await stopUsageLog();
    setLogSink(null);
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  // These tests write to the config provider: the real provider, so the
  // project-file scope rule is the one tested.
  layer(
    FakeHost.layer(
      {},
      { config: new MemoryConfigProvider(TEXRA_SETTINGS.catalog) },
    ),
    { buildPerTest: true, excludeTestServices: true },
  )('texra.telemetry.enabled opt-out', (it) => {
    // Optional entries must be discarded without a request.
    async function expectNoOptionalUsageSent(
      config: WorkspaceRoots['config'],
    ): Promise<void> {
      const fetchMock = stubBatchFetch();

      logUsage(usageEntry('optional'), config);
      await vi.advanceTimersByTimeAsync(0);

      expect(fetchMock).not.toHaveBeenCalled();
    }

    it.effect('does not let a project opt in over a user-wide opt-out', () =>
      Effect.gen(function* () {
        yield* startUsageLog(DEFAULT_CONFIG);
        const { config } = (yield* FakeHost).roots;
        yield* config.update(TELEMETRY_ENABLED_SETTING.key, false, 'global');
        yield* config.update(TELEMETRY_ENABLED_SETTING.key, true, 'workspace');

        yield* Effect.promise(() => expectNoOptionalUsageSent(config));
      }),
    );

    // The setting is read live, so turning it off has to drop rounds already
    // queued under the old value rather than letting the next flush ship them.
    it.effect('discards entries queued before the setting was turned off', () =>
      Effect.gen(function* () {
        yield* startUsageLog({ batchSize: 100, flushIntervalMs: 60_000 });
        const { config } = (yield* FakeHost).roots;

        const fetchMock = stubBatchFetch();

        logUsage(usageEntry('before-opt-out'), config);
        yield* config.update(TELEMETRY_ENABLED_SETTING.key, false, 'global');

        yield* Effect.promise(() => vi.advanceTimersByTimeAsync(60_000));

        expect(fetchMock).not.toHaveBeenCalled();
      }),
    );

    // The environment kill switch is what a user has when editing settings is
    // awkward: a CI job, a shared machine, or a one-off `TEXRA_NO_TELEMETRY=1
    // texra run`. It overrides a stored `true` and cannot re-enable logging.
    it.effect('sends nothing while TEXRA_NO_TELEMETRY=1 is set', () =>
      Effect.gen(function* () {
        yield* startUsageLog(DEFAULT_CONFIG);
        const { config } = (yield* FakeHost).roots;
        yield* config.update(TELEMETRY_ENABLED_SETTING.key, true, 'global');
        vi.stubEnv('TEXRA_NO_TELEMETRY', '1');

        yield* Effect.promise(() => expectNoOptionalUsageSent(config));
      }),
    );
  });

  it('sends only a bundled agent id; any other agent name is "custom"', () => {
    expect(usageAgentName('orchestrator', AGENT_SOURCE.BUILT_IN)).toBe(
      'orchestrator',
    );
    expect(usageAgentName('my-thesis-notes', AGENT_SOURCE.CUSTOM)).toBe(
      'custom',
    );
    expect(usageAgentName('acme:secret', AGENT_SOURCE.PLUGIN)).toBe('custom');
    expect(usageAgentName('unsourced', undefined)).toBe('custom');
  });
});
