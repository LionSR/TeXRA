import { it } from '@effect/vitest';
import { Context, Effect, Exit, Layer, Scope } from 'effect';
import { afterEach, beforeEach, describe, expect, vi, type Mock } from 'vitest';

import { effectDiagnosticsLayer } from '@logger/effectDiagnostics';
import { setLogSink } from '@logger/logSink';
import { MemoryConfigProvider } from '@platform/defaults/memoryConfigProvider';
import { AGENT_SOURCE } from '@shared/schemas';
import { UsageLog, usageAgentName } from '@shared/usageLog';
import {
  usageLogLayer,
  type UsageLogOptions,
} from '@telemetry/UsageLogService';
import { testWorkspaceRoots } from '@test/support/testWorkspaceRoots';
import { testRuntime } from '@test/support/testProcessRuntime';
import { jsonResponse } from '@test/support/fetchTestUtils';
import { setupPlatform } from '@test/support/setupPlatform';
import {
  TELEMETRY_ENABLED_KEY,
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

// The Effect fetch client passes (url, init); read each batch body from the
// init.
function stubBatchFetch(): { batches: unknown[]; fetchMock: Mock } {
  const batches: unknown[] = [];
  const fetchMock = vi.fn(async (_url: URL, init: RequestInit) => {
    batches.push(await new Response(init.body).json());
    return jsonResponse({ success: true, accepted: 1 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { batches, fetchMock };
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
    if (scope) await testRuntime().runPromise(Scope.close(scope, Exit.void));
  };

  const startUsageLog = async (
    config: UsageLogOptions['config'],
  ): Promise<void> => {
    await stopUsageLog();
    lifetime = Scope.makeUnsafe();
    const context = await testRuntime().runPromise(
      Scope.provide(
        // The process runtime's diagnostics, which the service logs through.
        Layer.build(
          usageLogLayer({
            version: undefined,
            editorType: undefined,
            config,
          }).pipe(Layer.provide(effectDiagnosticsLayer('Trace'))),
        ),
        lifetime,
      ),
    );
    usageLog = Context.get(context, UsageLog);
  };

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await startUsageLog({
      batchSize: 1,
      flushIntervalMs: 60_000,
      enabled: true,
    });
  });

  afterEach(async () => {
    await stopUsageLog();
    setLogSink(null);
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  describe('texra.telemetry.enabled opt-out', () => {
    // These tests write to the config provider. Without a per-test platform the
    // mutation outlives the test — the file-scoped fake from setupFakePlatform
    // is shared — and a stray `enabled: false` silently disables logging for
    // every suite that runs afterwards.
    // The real provider, so the project-file scope rule is the one tested.
    setupPlatform({}, { config: new MemoryConfigProvider(TEXRA_SETTINGS) });

    // Optional entries must be discarded without a request.
    async function expectNoOptionalUsageSent(): Promise<void> {
      const { batches, fetchMock } = stubBatchFetch();

      logUsage(usageEntry('optional'), testWorkspaceRoots().config);
      await vi.advanceTimersByTimeAsync(0);

      expect(fetchMock).not.toHaveBeenCalled();
      expect(batches).toEqual([]);
    }

    it.live('does not let a project opt in over a user-wide opt-out', () =>
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
    it.live('discards entries queued before the setting was turned off', () =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          startUsageLog({ batchSize: 100, flushIntervalMs: 60_000 }),
        );

        const { batches, fetchMock } = stubBatchFetch();

        logUsage(usageEntry('before-opt-out'), testWorkspaceRoots().config);
        yield* testWorkspaceRoots().config.update(
          TELEMETRY_ENABLED_KEY,
          false,
          'global',
        );

        yield* Effect.promise(() => vi.advanceTimersByTimeAsync(60_000));

        expect(fetchMock).not.toHaveBeenCalled();
        expect(batches).toEqual([]);
      }),
    );

    // The environment kill switch is what a user has when editing settings is
    // awkward: a CI job, a shared machine, or a one-off `TEXRA_NO_TELEMETRY=1
    // texra run`. It overrides a stored `true` and cannot re-enable logging.
    it.live.each([['TEXRA_NO_TELEMETRY', '1']])(
      'sends nothing while %s=%s is set',
      ([name, value]) =>
        Effect.gen(function* () {
          yield* testWorkspaceRoots().config.update(
            TELEMETRY_ENABLED_KEY,
            true,
            'global',
          );
          vi.stubEnv(name, value);

          yield* Effect.promise(() => expectNoOptionalUsageSent());
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
