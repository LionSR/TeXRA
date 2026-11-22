import { it, layer } from '@effect/vitest';
import { Context, Effect, Exit, Layer, Scope } from 'effect';
import { TestClock } from 'effect/testing';
import { FetchHttpClient } from 'effect/http';
import { afterEach, describe, expect, vi, type Mock } from 'vitest';

import { effectDiagnosticsLayer, setLogSink } from '@texra-ai/worldline/node';
import { AppState } from '@texra-ai/worldline/plugins';
import { UsageLog } from '@texra-ai/worldline/host';
import { MemoryConfigProvider } from '@platform/defaults/memoryConfigProvider';
import type { WorkspaceRoots } from '@platform/workspaceRoots';
import { usageAgentName } from '@shared/usageLog';
import { FLUSH_INTERVAL, usageLogLayer } from '@telemetry/UsageLogService';
import { telemetryNoticeIfDue } from '@telemetry/telemetryNotice';
import { jsonResponse } from '@test/support/fetchTestUtils';
import { FakeHost } from '@test/support/testKernel';
import {
  TELEMETRY_ENABLED_SETTING,
  TEXRA_SETTINGS,
} from '@texra/shared/settings/texraSettings';

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

type BatchFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

/** The usage endpoint; a case asserts it is never reached. */
function batchFetch(): Mock<BatchFetch> {
  return vi.fn<BatchFetch>(async () =>
    jsonResponse({ success: true, accepted: 1 }),
  );
}

describe('UsageLogService', () => {
  /** The service over the test host's app state, where the install id is
   *  kept, built in the case's scope: closing that scope is the host's
   *  runtime disposal, which sends what is still queued and returns once
   *  nothing more can be sent. Its requests go to `fetch`. */
  const startUsageLog = Effect.fnUntraced(function* (fetch: BatchFetch) {
    const host = yield* FakeHost;
    // A child of the case's scope: a case that fails before `stop` still
    // closes it, so no sender or ticker outlives the case.
    const scope = yield* Scope.fork(yield* Scope.Scope);
    const context = yield* Layer.buildWithScope(
      usageLogLayer({ version: undefined, editorType: undefined }).pipe(
        Layer.provide(
          Layer.mergeAll(
            // The process runtime's diagnostics, which the service logs
            // through; the case's fetch; and the host's app state.
            effectDiagnosticsLayer('Trace'),
            FetchHttpClient.layer.pipe(
              Layer.provide(Layer.succeed(FetchHttpClient.Fetch)(fetch)),
            ),
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
      config: WorkspaceRoots['config'],
      configure: Effect.Effect<
        void,
        Effect.Error<ReturnType<WorkspaceRoots['config']['update']>>
      >,
    ) {
      const fetchMock = batchFetch();
      const usageLog = yield* startUsageLog(fetchMock);
      yield* configure;

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
        const { config } = (yield* FakeHost).roots;
        yield* expectNoOptionalUsageSent(
          config,
          Effect.gen(function* () {
            yield* config.update(
              TELEMETRY_ENABLED_SETTING.key,
              false,
              'global',
            );
            yield* config.update(
              TELEMETRY_ENABLED_SETTING.key,
              true,
              'workspace',
            );
          }),
        );
      }),
    );

    // The setting is read live, so turning it off has to drop rounds already
    // queued under the old value rather than letting the next flush ship them.
    it.effect('discards entries queued before the setting was turned off', () =>
      Effect.gen(function* () {
        const fetchMock = batchFetch();
        const usageLog = yield* startUsageLog(fetchMock);
        const { config } = (yield* FakeHost).roots;

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
        const { config } = (yield* FakeHost).roots;
        yield* expectNoOptionalUsageSent(
          config,
          Effect.gen(function* () {
            yield* config.update(TELEMETRY_ENABLED_SETTING.key, true, 'global');
            vi.stubEnv('TEXRA_NO_TELEMETRY', '1');
          }),
        );
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
        const { config } = (yield* FakeHost).roots;
        const bodies: { entries: { model: string }[] }[] = [];
        const firstSent = Promise.withResolvers<void>();
        const usageLog = yield* startUsageLog(
          async (_input: RequestInfo | URL, init?: RequestInit) => {
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
          },
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

  it("sends only a listed program's name; any other run sends none", () => {
    const program = (name: string) => ({
      script: { kind: 'program' as const, name, args: {} },
    });
    expect(usageAgentName(program('review'))).toBe('review');
    expect(usageAgentName(program('acme:secret'))).toBeUndefined();
    expect(usageAgentName(program('own:notes'))).toBeUndefined();
    expect(usageAgentName({})).toBeUndefined();
  });
});
