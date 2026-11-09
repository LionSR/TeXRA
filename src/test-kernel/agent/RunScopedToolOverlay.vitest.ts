import { layer } from '@effect/vitest';
import { Effect, Layer, Schema, Context } from 'effect';
import { assert, expect, vi } from 'vitest';

import {
  AgentConfigSchema,
  generateRunId,
  type RunId,
} from '@texra-ai/harness/schemas';
import {
  AppState,
  mcpConfigPathOf,
  ValidationModel,
} from '@texra-ai/harness/host';
import { ModelInvoker } from '@agent/runtime/ModelInvoker';
import type { InvokeRequest } from '@agent/runtime/run/recordedRequest';
import { stepFor } from '@agent/runtime/loop/step';
import { openToolUse, runToolUse } from '@agent/runtime/loop/runLoop';
import {
  AgentRun,
  agentRunLayer,
  type RunLaunch,
} from '@agent/runtime/run/AgentRun';
import type { SessionServices } from '@agent/runtime/rootLaunch';
import { validationModel } from '@cli/runtime/models/validationModel';
import { RunHistory } from '@shared/session/runHistory';
import { nativeToolTestLayer } from '@test/support/nativeToolTestLayer';
import { noHttpClientLayer } from '@test/support/fetchTestUtils';
import { buildTestModelConfig } from '@test/support/modelConfigTestUtils';
import { publishTestRunStart } from '@test/support/sessionTestUtils';
import { nodePlatformLayer } from '@test/support/fsTestUtils';
import { nodeSpawnerLayer } from '@test/support/childProcessTestLayer';
import {
  createFakeWorkspaceRoots,
  FakeSecrets,
} from '@test/support/FakePlatform';
import {
  FakeHost,
  isolatedTestSession,
  SessionGraph,
} from '@test/support/testKernel';
import { texraPlugins } from '@texra/tools/registry';
import { pluginCatalogLayer } from '@tools/pluginCatalog';
import { toolTable } from '@tools/toolTable';

import { testLaunch } from '@test/support/scriptedRunLayers';
import { noopTrace } from '@test/support/noopTrace';
import { AppSignals, Secrets, type ITool } from '@texra-ai/harness/plugins';

function tool(name: string): ITool {
  return {
    definition: { name, description: name, parameters: {} },
    call: vi.fn(),
  };
}

/** A launch whose model binds without a credential (the validation model). */
function validationLaunch(
  runId: RunId,
  config: RunLaunch['config'],
): RunLaunch {
  return testLaunch(runId, {
    config: { ...config, instruction: 'Do the thing.' },
    // Headless: the turn ends the run instead of parking for input.
    toolPolicy: { stopAfterCycle: true },
  });
}

/** A model that records the tools it was offered and then stops the run. */
function observingInvokerLayer(seen: InvokeRequest[]) {
  return Layer.succeed(ModelInvoker, {
    call: () => Effect.die(new Error('No compaction in this scenario.')),
    invoke: (cell, request) =>
      Effect.gen(function* () {
        seen.push(request);
        return { kind: 'cancelled' as const, state: yield* cell.current };
      }),
  });
}

/** The run's layer over a launch, with the given run-scoped tools. */
function runLayer(
  session: Context.Context<SessionServices>,
  ctx: RunLaunch,
  tools: ITool[],
  seen: InvokeRequest[] = [],
) {
  return Layer.mergeAll(
    observingInvokerLayer(seen),
    nativeToolTestLayer(),
  ).pipe(
    Layer.provideMerge(
      agentRunLayer(ctx, {
        modelConfig: buildTestModelConfig(),
        tools,
        callbacks: {},
      }),
    ),
    Layer.provideMerge(Layer.succeedContext(session)),
    Layer.provideMerge(noHttpClientLayer),
    // No key is read: every launch here binds the validation model.
    Layer.provideMerge(Secrets.layer(new FakeSecrets())),
    Layer.provideMerge(
      pluginCatalogLayer(
        toolTable(texraPlugins({ name: 'vscode' })),
        mcpConfigPathOf(createFakeWorkspaceRoots().storageRoot),
      ).pipe(
        Layer.provide(
          Layer.mergeAll(
            nodePlatformLayer,
            Layer.unwrap(
              FakeHost.useSync((host) =>
                AppState.layer(host.roots.globalState),
              ),
            ),
            AppSignals.layer,
          ),
        ),
      ),
    ),
    Layer.provideMerge(nodeSpawnerLayer),
    // Every launch here binds the deterministic in-process model through
    // the real route.
    Layer.provideMerge(
      Layer.succeed(ValidationModel)({
        enabled: Effect.succeed(true),
        bind: validationModel(
          Effect.succeed({
            scriptFanout: false,
            historyQuery: false,
            echo: false,
            golden: null,
          }),
        ),
      }),
    ),
  );
}

layer(
  Layer.provideMerge(
    SessionGraph.layer,
    FakeHost.layer({ workspaceRoot: process.cwd() }),
  ),
  { excludeTestServices: true },
)('run-scoped tool resolution', (it) => {
  it.effect(
    'a resumed step offers the recorded tools that are still the same tool, and names each one gone',
    () =>
      Effect.gen(function* () {
        const session = yield* isolatedTestSession({ emit: () => {} });
        const runId = generateRunId();
        yield* publishTestRunStart(session, runId);
        const config = Schema.decodeUnknownSync(AgentConfigSchema)({
          agent: 'chat',
          model: 'test-model',
          workingDirectory: process.cwd(),
        });
        const ctx = validationLaunch(runId, config);
        yield* Effect.flatMap(openToolUse({ resume: false }), (opened) =>
          runToolUse({ resume: false }, opened),
        ).pipe(
          Effect.provide(runLayer(session, ctx, [tool('gone'), tool('kept')])),
          Effect.orDie,
        );

        // `gone` vanished and `added` appeared since the run opened.
        const step = yield* Effect.gen(function* () {
          const state = yield* Context.get(session, RunHistory).load(runId);
          assert(state !== null);
          return yield* stepFor(yield* AgentRun, state, false);
        }).pipe(
          Effect.provide(runLayer(session, ctx, [tool('kept'), tool('added')])),
          Effect.orDie,
        );

        expect(step.tools.definitions.map(({ name }) => name)).toEqual([
          'kept',
        ]);
        expect(step.tools.registry.has('gone')).toBe(false);
        expect(step.tools.registry.has('added')).toBe(false);
        // The narrower set is recorded before the resumed request, and the
        // model is told, after the history its cached prefix holds.
        expect(step.rows.map(({ type }) => type)).toEqual([
          'context.blob',
          'tools.offered',
          'model.message',
        ]);
        const told = step.rows.at(-1);
        assert(told?.type === 'model.message');
        expect(told.payload).toMatchObject({
          kind: 'append',
          messages: [
            {
              role: 'system',
              text: 'These tools are no longer available; do not call them: gone.',
            },
          ],
        });
      }),
  );

  it.effect('a resumed step names an activated skill it no longer offers', () =>
    Effect.gen(function* () {
      const session = yield* isolatedTestSession({ emit: () => {} });
      const runId = generateRunId();
      yield* publishTestRunStart(session, runId);
      const config = Schema.decodeUnknownSync(AgentConfigSchema)({
        agent: 'chat',
        model: 'test-model',
        workingDirectory: process.cwd(),
      });
      const warnings: string[] = [];
      const ctx = {
        ...validationLaunch(runId, config),
        logger: {
          ...noopTrace,
          warn: (message: string) => void warnings.push(message),
        },
      };
      yield* Effect.flatMap(openToolUse({ resume: false }), (opened) =>
        runToolUse({ resume: false }, opened),
      ).pipe(Effect.provide(runLayer(session, ctx, [])), Effect.orDie);

      // The user activated a Lean skill; the Lean plugin is not available
      // in this workspace when the run resumes.
      yield* Effect.gen(function* () {
        const state = yield* Context.get(session, RunHistory).load(runId);
        assert(state !== null);
        return yield* stepFor(
          yield* AgentRun,
          { ...state, input: { ...state.input, activated: ['lean-search'] } },
          false,
        );
      }).pipe(Effect.provide(runLayer(session, ctx, [])), Effect.orDie);

      expect(warnings).toContainEqual(
        expect.stringContaining('Skill "lean-search"'),
      );
    }),
  );
});
