import '@test/support/defaultSessionTestSetup';

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { it } from '@effect/vitest';
import { Effect, Layer, Schema } from 'effect';
import { afterAll, assert, beforeAll, describe, expect, vi } from 'vitest';

import type { ITool } from '@agent/core/tools/ToolTypes';
import type { AgentLaunchContext } from '@agent/runtime/AgentLaunchContext';
import { ModelInvoker } from '@agent/runtime/ModelInvoker';
import type { InvokeRequest } from '@agent/runtime/run/requestContext';
import { stepFor } from '@agent/runtime/loop/step';
import { runToolUse } from '@agent/runtime/loop/toolUse';
import { AgentRun, agentRunLayer } from '@agent/runtime/run/AgentRun';
import { AppState } from '@platform/interfaces';
import { Secrets } from '@platform/secrets';
import { AgentConfigSchema } from '@shared/schemas';
import { RunHistory } from '@shared/session/runHistory';
import { closeSessionOf } from '@test/support/sessionEnd';
import { nativeToolTestLayer } from '@test/support/nativeToolTestLayer';
import { testHttpClientLayer } from '@test/support/fetchTestUtils';
import { fakeHostAppState, setupPlatform } from '@test/support/setupPlatform';
import { buildTestModelConfig } from '@test/support/modelConfigTestUtils';
import { publishTestRunStart } from '@test/support/sessionTestUtils';
import { nodePlatformLayer } from '@test/support/fsTestUtils';
import { nodeSpawnerLayer } from '@test/support/childProcessTestLayer';
import {
  createFakeWorkspaceRoots,
  FakeSecrets,
} from '@test/support/FakePlatform';
import { texraPlugins } from '@texra/tools/registry';
import { mcpConfigPathOf } from '@tools/mcp/mcpConfig';
import { pluginCatalogLayer } from '@tools/pluginCatalog';
import { generateRunId } from '@utils/core';

import { sessionWithInteractions } from './progressTestUtils';
import { createTestLaunchContext } from './runtime/launchContextTestUtils';

function tool(name: string): ITool {
  return {
    definition: { name, description: name, parameters: {} },
    call: vi.fn(),
  };
}

/** A launch whose model binds without a credential (the validation model). */
function validationLaunch(
  init: Parameters<typeof createTestLaunchContext>[0],
  config: AgentLaunchContext['config'],
): AgentLaunchContext {
  return {
    ...createTestLaunchContext(init),
    config: { ...config, instruction: 'Do the thing.' },
    // Headless: the turn ends the run instead of parking for input.
    toolPolicy: { stopAfterCycle: true },
    modelConfig: buildTestModelConfig(),
  };
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
  ctx: AgentLaunchContext,
  tools: ITool[],
  seen: InvokeRequest[] = [],
) {
  return Layer.mergeAll(
    observingInvokerLayer(seen),
    nativeToolTestLayer(),
  ).pipe(
    Layer.provideMerge(agentRunLayer(ctx, { tools, callbacks: {} })),
    Layer.provideMerge(Layer.succeed(RunHistory, ctx.session.runHistory)),
    Layer.provideMerge(testHttpClientLayer),
    // No key is read: every launch here binds the validation model.
    Layer.provideMerge(Secrets.layer(new FakeSecrets())),
    Layer.provideMerge(
      pluginCatalogLayer(
        texraPlugins(),
        mcpConfigPathOf(createFakeWorkspaceRoots().storageRoot),
      ).pipe(
        Layer.provide(
          Layer.merge(nodePlatformLayer, AppState.layer(fakeHostAppState)),
        ),
      ),
    ),
    Layer.provideMerge(nodeSpawnerLayer),
  );
}

// Every launch here binds the deterministic in-process model through the
// real route: the guarded package-validation gate, opened as validation opens it.
beforeAll(() => {
  const flag = path.join(mkdtempSync(path.join(tmpdir(), 'texra-vm-')), 'flag');
  writeFileSync(flag, 'overlay');
  for (const [name, value] of Object.entries({
    TEXRA_CLI_INCLUDE_INTERNAL_VALIDATION_MODEL: '1',
    TEXRA_CLI_INTERNAL_VALIDATION_MODEL_ENV: 'TEXRA_OVERLAY_VALIDATION',
    TEXRA_OVERLAY_VALIDATION: '1',
    TEXRA_CLI_INTERNAL_VALIDATION_MODEL_FLAG_ENV: 'TEXRA_OVERLAY_FLAG',
    TEXRA_OVERLAY_FLAG: flag,
    TEXRA_CLI_INTERNAL_VALIDATION_MODEL_FLAG_CONTENT: 'overlay',
  }))
    vi.stubEnv(name, value);
});
afterAll(() => {
  vi.unstubAllEnvs();
});

describe('run-scoped tool resolution', () => {
  setupPlatform({ workspacePath: process.cwd() });

  it.effect(
    'a resumed step offers the recorded tools that are still the same tool, and names each one gone',
    () =>
      Effect.gen(function* () {
        const session = yield* sessionWithInteractions({ emit: () => {} });
        const runId = generateRunId();
        publishTestRunStart(session, runId);
        const config = Schema.decodeUnknownSync(AgentConfigSchema)({
          agent: 'chat',
          model: 'test-model',
          workingDirectory: process.cwd(),
        });
        const ctx = validationLaunch({ runId, session }, config);
        yield* runToolUse({ resume: false }).pipe(
          Effect.provide(runLayer(ctx, [tool('gone'), tool('kept')])),
          Effect.orDie,
        );

        // `gone` vanished and `added` appeared since the run opened.
        const step = yield* Effect.gen(function* () {
          const state = yield* session.runHistory.load(runId);
          return yield* stepFor(yield* AgentRun, state!, 'request', false);
        }).pipe(
          Effect.provide(runLayer(ctx, [tool('kept'), tool('added')])),
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
        yield* closeSessionOf(session);
      }),
  );
});
