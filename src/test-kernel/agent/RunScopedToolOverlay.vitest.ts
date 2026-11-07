import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { layer } from '@effect/vitest';
import { Effect, Layer, Schema, Context } from 'effect';
import { afterAll, assert, beforeAll, expect, vi } from 'vitest';

import {
  AgentConfigSchema,
  generateRunId,
  type RunId,
} from '@texra-ai/harness/schemas';
import {
  AppSignals,
  AppState,
  mcpConfigPathOf,
  Secrets,
} from '@texra-ai/harness/host';
import { ModelInvoker } from '@agent/runtime/ModelInvoker';
import type { InvokeRequest } from '@agent/runtime/run/requestContext';
import { stepFor } from '@agent/runtime/loop/step';
import { openToolUse, runToolUse } from '@agent/runtime/loop/toolUse';
import {
  AgentRun,
  agentRunLayer,
  type RunLaunch,
} from '@agent/runtime/run/AgentRun';
import type { SessionServices } from '@agent/runtime/rootLaunch';
import { validationModelLayer } from '@cli/runtime/validationModel';
import { RunHistory } from '@shared/session/runHistory';
import { nativeToolTestLayer } from '@test/support/nativeToolTestLayer';
import { testHttpClientLayer } from '@test/support/fetchTestUtils';
import { fakeHostAppState } from '@test/support/setupPlatform';
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

import { testLaunch } from '@test/support/scriptedRunLayers';
import type { ITool } from '@texra-ai/harness';

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
    Layer.provideMerge(testHttpClientLayer),
    // No key is read: every launch here binds the validation model.
    Layer.provideMerge(Secrets.layer(new FakeSecrets())),
    Layer.provideMerge(
      pluginCatalogLayer(
        texraPlugins({ name: 'vscode' }),
        mcpConfigPathOf(createFakeWorkspaceRoots().storageRoot),
      ).pipe(
        Layer.provide(
          Layer.mergeAll(
            nodePlatformLayer,
            AppState.layer(fakeHostAppState),
            AppSignals.layer,
          ),
        ),
      ),
    ),
    Layer.provideMerge(nodeSpawnerLayer),
    Layer.provideMerge(validationModelLayer),
  );
}

// Every launch here binds the deterministic in-process model through the
// real route: the guarded package-validation gate, opened as validation opens it.
beforeAll(() => {
  const flag = path.join(mkdtempSync(path.join(tmpdir(), 'texra-vm-')), 'flag');
  writeFileSync(flag, 'texra-cli-run-validation');
  for (const [name, value] of Object.entries({
    TEXRA_INTERNAL_VALIDATE_MODEL: '1',
    TEXRA_INTERNAL_VALIDATE_MODEL_FLAG: flag,
  }))
    vi.stubEnv(name, value);
});
afterAll(() => {
  vi.unstubAllEnvs();
});

layer(
  Layer.provideMerge(
    SessionGraph.layer,
    FakeHost.layer({ workspacePath: process.cwd() }),
  ),
  { excludeTestServices: true },
)('run-scoped tool resolution', (it) => {
  it.effect(
    'a resumed step offers the recorded tools that are still the same tool, and names each one gone',
    () =>
      Effect.gen(function* () {
        const session = yield* isolatedTestSession({ emit: () => {} });
        const runId = generateRunId();
        publishTestRunStart(session, runId);
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
});
