import { it, layer } from '@effect/vitest';
import { Context, Effect, Exit, Layer, Scope } from 'effect';
import { TestClock } from 'effect/testing';
import { afterEach, describe, expect, vi, type Mock } from 'vitest';

import { AGENT_SOURCE } from '@texra-ai/harness/schemas';
import { effectDiagnosticsLayer, setLogSink } from '@texra-ai/harness/node';
import { AppState, UsageLog } from '@texra-ai/harness/host';
import { MemoryConfigProvider } from '@platform/defaults/memoryConfigProvider';
import type { WorkspaceRoots } from '@platform/workspaceRoots';
import { usageAgentName } from '@shared/usageLog';
import { FLUSH_INTERVAL, usageLogLayer } from '@telemetry/UsageLogService';
import { telemetryNoticeIfDue } from '@telemetry/telemetryNotice';
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
  /** The service over the test host's app state, where the install id is
   *  kept, built in the case's scope: closing that scope is the host's
   *  runtime disposal, which sends what is still queued and returns once
   *  nothing more can be sent. */
  const startUsageLog = Effect.gen(function* () {
    const host = yield* FakeHost;
    const scope = yield* Scope.make();
    const context = yield* Layer.buildWithScope(
      usageLogLayer({ version: undefined, editorType: undefined }).pipe(
        Layer.provide(
          Layer.mergeAll(
            // The process runtime's diagnostics, which the service logs
            // through; the fetch each test stubs; and the host's app state.
            effectDiagnosticsLayer('Trace'),
            testHttpClientLayer,
            AppState.layer(host.roots.globalState),
          ),
        ),
      ),
      scope,
    );
    const usageLog = Context.get(context, UsageLog);
    return {
      /** Queue one entry, as the invoker's usage report does. */
      log: (...args: Parameters<UsageLog['Service']['log']>) =>
        usageLog.log(...args),
      stop: Scope.close(scope, Exit.void),
    };
  });

  afterEach(() => {
    setLogSink(null);
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
    { buildPerTest: true },
  )('texra.telemetry.enabled opt-out', (it) => {
    // Optional entries must be discarded without a request, by the periodic
    // flush and by the final drain alike.
    const expectNoOptionalUsageSent = Effect.fnUntraced(function* (
      usageLog: Effect.Success<typeof startUsageLog>,
      config: WorkspaceRoots['config'],
    ) {
      const fetchMock = stubBatchFetch();

      yield* usageLog.log(usageEntry('optional'), config);
      yield* TestClock.adjust(FLUSH_INTERVAL);
      yield* usageLog.stop;

      expect(fetchMock).not.toHaveBeenCalled();
    });

    // The notice and the doctor hint quote the line a user pastes into the
    // config file, where keys carry the catalog's namespace: the bare row
    // key is ignored there and logging stays on.
    it.effect('the first-run notice names the stored key', () =>
      Effect.gen(function* () {
        const host = yield* FakeHost;
        const notice = yield* telemetryNoticeIfDue(host.roots.config).pipe(
          Effect.provide(AppState.layer(host.roots.globalState)),
        );
        expect(notice).toContain('"texra.telemetry.enabled": false');
        expect(notice).not.toContain('"telemetry.enabled": false');
      }),
    );

    it.effect('does not let a project opt in over a user-wide opt-out', () =>
      Effect.gen(function* () {
        const usageLog = yield* startUsageLog;
        const { config } = (yield* FakeHost).roots;
        yield* config.update(TELEMETRY_ENABLED_SETTING.key, false, 'global');
        yield* config.update(TELEMETRY_ENABLED_SETTING.key, true, 'workspace');

        yield* expectNoOptionalUsageSent(usageLog, config);
      }),
    );

    // The setting is read live, so turning it off has to drop rounds already
    // queued under the old value rather than letting the next flush ship them.
    it.effect('discards entries queued before the setting was turned off', () =>
      Effect.gen(function* () {
        const usageLog = yield* startUsageLog;
        const { config } = (yield* FakeHost).roots;

        const fetchMock = stubBatchFetch();

        yield* usageLog.log(usageEntry('before-opt-out'), config);
        yield* config.update(TELEMETRY_ENABLED_SETTING.key, false, 'global');

        yield* TestClock.adjust(FLUSH_INTERVAL);
        yield* usageLog.stop;

        expect(fetchMock).not.toHaveBeenCalled();
      }),
    );

    // The environment kill switch is what a user has when editing settings is
    // awkward: a CI job, a shared machine, or a one-off `TEXRA_NO_TELEMETRY=1
    // texra run`. It overrides a stored `true` and cannot re-enable logging.
    it.effect('sends nothing while TEXRA_NO_TELEMETRY=1 is set', () =>
      Effect.gen(function* () {
        const usageLog = yield* startUsageLog;
        const { config } = (yield* FakeHost).roots;
        yield* config.update(TELEMETRY_ENABLED_SETTING.key, true, 'global');
        vi.stubEnv('TEXRA_NO_TELEMETRY', '1');

        yield* expectNoOptionalUsageSent(usageLog, config);
      }),
    );
  });

  layer(
    FakeHost.layer(
      {},
      { config: new MemoryConfigProvider(TEXRA_SETTINGS.catalog) },
    ),
    { buildPerTest: true },
  )('delivery', (it) => {
    // The client checks every entry against the schema the edge decodes, so
    // the edge rejecting a batch means the two versions disagree: that batch
    // is dropped, and the entries after it still go out.
    it.effect('a rejected batch does not block the next good entry', () =>
      Effect.gen(function* () {
        const usageLog = yield* startUsageLog;
        const { config } = (yield* FakeHost).roots;
        const bodies: { entries: { model: string }[] }[] = [];
        const firstSent = Promise.withResolvers<void>();
        vi.stubGlobal(
          'fetch',
          vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
            const body = (await new Response(init?.body).json()) as {
              entries: { model: string }[];
            };
            bodies.push(body);
            firstSent.resolve();
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

        yield* usageLog.log(usageEntry('skewed'), config);
        yield* TestClock.adjust(FLUSH_INTERVAL);
        // The rejected batch has left the queue once its request is made.
        yield* Effect.promise(() => firstSent.promise);
        yield* usageLog.log(usageEntry('good'), config);
        yield* TestClock.adjust(FLUSH_INTERVAL);
        yield* usageLog.stop;

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
