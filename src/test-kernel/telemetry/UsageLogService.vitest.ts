import { it, layer } from '@effect/vitest';
import { Context, Effect, Exit, Layer, Scope } from 'effect';
import { afterEach, beforeEach, describe, expect, vi, type Mock } from 'vitest';

import { AGENT_SOURCE } from '@texra-ai/harness/schemas';
import { effectDiagnosticsLayer, setLogSink } from '@texra-ai/harness/node';
import { AppState, UsageLog } from '@texra-ai/harness/host';
import { MemoryConfigProvider } from '@platform/defaults/memoryConfigProvider';
import { usageAgentName } from '@shared/usageLog';
import { usageLogLayer } from '@telemetry/UsageLogService';
import { testWorkspaceRoots } from '@test/support/testWorkspaceRoots';
import {
  jsonResponse,
  testHttpClientLayer,
} from '@test/support/fetchTestUtils';
import { fakeHostAppState } from '@test/support/setupPlatform';
import { FakeHost } from '@test/support/testKernel';
import {
  TELEMETRY_ENABLED_KEY,
  TEXRA_SETTINGS,
} from '@texra/shared/settingsView/texraSettings';

/** The shipped periodic flush. */
const FLUSH_INTERVAL_MS = 30_000;

function usageEntry(model: string) {
  return {
    model,
    provider: 'openai-responses' as const,
    agentName: 'agent',
    inputTokens: 1,
    outputTokens: 1,
    listCost: 0.001,
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

  const startUsageLog = async (): Promise<void> => {
    await stopUsageLog();
    lifetime = Scope.makeUnsafe();
    const context = await Effect.runPromise(
      Scope.provide(
        Layer.build(
          usageLogLayer({
            version: undefined,
            editorType: undefined,
          }).pipe(
            Layer.provide(
              Layer.mergeAll(
                // The process runtime's diagnostics, which the service logs
                // through; the fetch each test stubs; and the installed
                // host's app state, where the install id is kept.
                effectDiagnosticsLayer('Trace'),
                testHttpClientLayer,
                AppState.layer(fakeHostAppState),
              ),
            ),
          ),
        ),
        lifetime,
      ),
    );
    usageLog = Context.get(context, UsageLog);
  };

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await startUsageLog();
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
    async function expectNoOptionalUsageSent(): Promise<void> {
      const fetchMock = stubBatchFetch();

      logUsage(usageEntry('optional'), testWorkspaceRoots().config);
      await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS);

      expect(fetchMock).not.toHaveBeenCalled();
    }

    it.effect('does not let a project opt in over a user-wide opt-out', () =>
      Effect.gen(function* () {
        yield* testWorkspaceRoots().config.update(
          TELEMETRY_ENABLED_KEY,
          false,
          'global',
        );
        yield* testWorkspaceRoots().config.update(
          TELEMETRY_ENABLED_KEY,
          true,
          'workspace',
        );

        yield* Effect.promise(() => expectNoOptionalUsageSent());
      }),
    );

    // The setting is read live, so turning it off has to drop rounds already
    // queued under the old value rather than letting the next flush ship them.
    it.effect('discards entries queued before the setting was turned off', () =>
      Effect.gen(function* () {
        const fetchMock = stubBatchFetch();

        logUsage(usageEntry('before-opt-out'), testWorkspaceRoots().config);
        yield* testWorkspaceRoots().config.update(
          TELEMETRY_ENABLED_KEY,
          false,
          'global',
        );

        yield* Effect.promise(() =>
          vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS),
        );

        expect(fetchMock).not.toHaveBeenCalled();
      }),
    );

    // The environment kill switch is what a user has when editing settings is
    // awkward: a CI job, a shared machine, or a one-off `TEXRA_NO_TELEMETRY=1
    // texra run`. It overrides a stored `true` and cannot re-enable logging.
    it.effect('sends nothing while TEXRA_NO_TELEMETRY=1 is set', () =>
      Effect.gen(function* () {
        yield* testWorkspaceRoots().config.update(
          TELEMETRY_ENABLED_KEY,
          true,
          'global',
        );
        vi.stubEnv('TEXRA_NO_TELEMETRY', '1');

        yield* Effect.promise(() => expectNoOptionalUsageSent());
      }),
    );
  });

  layer(
    FakeHost.layer(
      {},
      { config: new MemoryConfigProvider(TEXRA_SETTINGS.catalog) },
    ),
    { buildPerTest: true, excludeTestServices: true },
  )('delivery', (it) => {
    // The client checks every entry against the schema the edge decodes, so
    // the edge rejecting a batch means the two versions disagree: that batch
    // is dropped, and the entries after it still go out.
    it.effect('a rejected batch does not block the next good entry', () =>
      Effect.gen(function* () {
        const bodies: { entries: { model: string }[] }[] = [];
        vi.stubGlobal(
          'fetch',
          vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
            const body = (await new Response(init?.body).json()) as {
              entries: { model: string }[];
            };
            bodies.push(body);
            return body.entries.some(({ model }) => model === 'skewed')
              ? jsonResponse({
                  success: false,
                  accepted: 0,
                  error: 'Invalid batch format or entry data',
                  retryable: false,
                  errorCode: 'BATCH_REJECTED',
                  issueCount: 1,
                  issues: [{ path: ['entries', '0', 'model'], message: 'x' }],
                })
              : jsonResponse({ success: true, accepted: body.entries.length });
          }),
        );

        logUsage(usageEntry('skewed'), testWorkspaceRoots().config);
        yield* Effect.promise(() =>
          vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS),
        );
        logUsage(usageEntry('good'), testWorkspaceRoots().config);
        yield* Effect.promise(() =>
          vi.advanceTimersByTimeAsync(4 * FLUSH_INTERVAL_MS),
        );

        expect(
          bodies.map(({ entries }) => entries.map(({ model }) => model)),
        ).toEqual([['skewed'], ['good']]);
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
