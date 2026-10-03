import '@test/support/defaultSessionTestSetup';

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { it } from '@effect/vitest';
import { Effect, Layer, SynchronizedRef } from 'effect';
import { afterAll, assert, beforeAll, describe, expect, vi } from 'vitest';

import { apiKeyEnvName, apiKeySecretName } from '@texra-ai/llm';
import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import {
  AgentPromptSchema,
  AgentSettingSchema,
  AgentToolUseSettingSchema,
} from '@agent/core/definition/AgentDataclass';
import type { ITool } from '@agent/core/tools/ToolTypes';
import type { AgentLaunchContext } from '@agent/runtime/AgentLaunchContext';
import { ModelInvoker, type InvokeRequest } from '@agent/runtime/ModelInvoker';
import { stepFor } from '@agent/runtime/loop/step';
import { runToolUse } from '@agent/runtime/loop/toolUse';
import { AgentRun, agentRunLayer } from '@agent/runtime/run/AgentRun';
import {
  LanguageModel,
  UNAVAILABLE_LANGUAGE_MODEL_PORT,
} from '@platform/languageModel';
import { AppState } from '@platform/interfaces';
import { AgentCategory } from '@shared/schemas';
import { RunLedger } from '@shared/session/runLedger';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { closeSessionOf } from '@test/support/sessionEnd';
import { noopTrace } from '@test/support/noopTrace';
import { nativeToolTestLayer } from '@test/support/nativeToolTestLayer';
import { testHttpClientLayer } from '@test/support/fetchTestUtils';
import {
  fakeHostAppState,
  hostStores,
  setupPlatform,
} from '@test/support/setupPlatform';
import { buildTestModelConfig } from '@test/support/modelConfigTestUtils';
import { publishTestRunStart } from '@test/support/sessionTestUtils';
import { resolveTestStep } from '@test/support/stepToolsTestUtils';
import { nodePlatformLayer } from '@test/support/fsTestUtils';
import { nodeSpawnerLayer } from '@test/support/childProcessTestLayer';
import { USER_MCP_CONFIG_PATH } from '@tools/mcp/mcpConfig';
import { pluginCatalogLayer } from '@tools/pluginCatalog';
import { texraPlugins } from '@tools/registry';
import { toolTableLayer } from '@tools/liveTools';
import { toolTable } from '@tools/toolTable';
import { generateRunId } from '@utils/core';

import { sessionWithInteractions } from './progressTestUtils';
import { createTestLaunchContext } from './runtime/launchContextTestUtils';

function tool(name: string): ITool {
  return {
    definition: { name, description: name, parameters: {} },
    call: vi.fn(),
  };
}

function approvalGatedTool(name: string): ITool {
  return { ...tool(name), requiresApproval: true };
}

/** A launch whose model binds without a credential (the validation model). */
function validationLaunch(
  init: Parameters<typeof createTestLaunchContext>[0],
  config: AgentLaunchContext['config'],
): AgentLaunchContext {
  return {
    ...createTestLaunchContext(init),
    config,
    prompt: AgentPromptSchema.parse({ userRequest: 'Do the thing.' }),
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
    Layer.provideMerge(Layer.succeed(RunLedger, ctx.session.ledger)),
    Layer.provideMerge(LanguageModel.layer(UNAVAILABLE_LANGUAGE_MODEL_PORT)),
    Layer.provideMerge(testHttpClientLayer),
    Layer.provideMerge(
      pluginCatalogLayer(texraPlugins(), USER_MCP_CONFIG_PATH).pipe(
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
    'adds the run-scoped tools and submit_output to the model-facing list',
    () =>
      Effect.gen(function* () {
        const session = yield* sessionWithInteractions({ emit: () => {} });
        const runId = generateRunId();
        publishTestRunStart(session, runId);
        const warn = vi.fn<typeof noopTrace.warn>();
        const logger = { ...noopTrace, warn };
        const config = AgentConfigSchema.parse({
          agent: 'chat',
          model: 'test-model',
          agentCategory: AgentCategory.ToolUse,
          workingDirectory: process.cwd(),
          outputSchema: {
            type: 'object',
            properties: { answer: { type: 'string' } },
            required: ['answer'],
          },
        });
        const ctx = validationLaunch({ runId, session, logger }, config);
        const seen: InvokeRequest[] = [];
        const shadowing = tool('bash');

        const dispatch = yield* Effect.gen(function* () {
          yield* runToolUse({ resume: false });
          const step = yield* SynchronizedRef.get((yield* AgentRun).steps);
          return step!.tools.registry;
        }).pipe(
          // Run-scoped tools, one of them shadowing a registered tool.
          Effect.provide(runLayer(ctx, [shadowing, tool('second')], seen)),
          Effect.orDie,
        );

        // The default-on injections, then the overlay tools and the synthetic
        // terminal tool, in overlay order.
        expect(seen[0]?.tools?.map(({ name }) => name)).toEqual([
          'memory',
          'plan',
          'bash',
          'second',
          'submit_output',
        ]);
        expect(warn).toHaveBeenCalledWith(
          'Run-scoped tool "bash" shadows an existing tool.',
        );
        // Dispatch answers the offered names only: a registered tool the run
        // did not offer is unknown, however the model came to name it.
        expect(dispatch.get('bash')).toBe(shadowing);
        expect(dispatch.has('grep')).toBe(false);
        yield* closeSessionOf(session);
      }),
  );

  it.effect(
    'a resumed step offers the recorded tools that are still the same tool, and names each one gone',
    () =>
      Effect.gen(function* () {
        const session = yield* sessionWithInteractions({ emit: () => {} });
        const runId = generateRunId();
        publishTestRunStart(session, runId);
        const warn = vi.fn<typeof noopTrace.warn>();
        const config = AgentConfigSchema.parse({
          agent: 'chat',
          model: 'test-model',
          agentCategory: AgentCategory.ToolUse,
          workingDirectory: process.cwd(),
        });
        const ctx = validationLaunch(
          { runId, session, logger: { ...noopTrace, warn } },
          config,
        );
        yield* runToolUse({ resume: false }).pipe(
          Effect.provide(runLayer(ctx, [tool('gone'), tool('kept')])),
          Effect.orDie,
        );

        // `gone` vanished and `added` appeared since the run opened.
        const resumed = yield* Effect.gen(function* () {
          const state = yield* session.ledger.load(runId);
          const step = yield* stepFor(
            yield* AgentRun,
            state!,
            false,
            'request',
            {
              base: () => undefined,
              isChild: () => false,
              activated: () => [],
            },
          );
          return { state: state!, step };
        }).pipe(
          Effect.provide(runLayer(ctx, [tool('kept'), tool('added')])),
          Effect.orDie,
        );

        expect(resumed.state.offeredTools?.map(({ name }) => name)).toEqual([
          'memory',
          'plan',
          'gone',
          'kept',
        ]);
        const offered = resumed.step.tools.definitions.map(({ name }) => name);
        expect(offered).toEqual(['memory', 'plan', 'kept']);
        expect(resumed.step.tools.registry.has('gone')).toBe(false);
        expect(resumed.step.tools.registry.has('added')).toBe(false);
        // The narrower set is recorded before the resumed request, and the
        // model is told, after the history its cached prefix holds.
        expect(resumed.step.rows.map(({ type }) => type)).toEqual([
          'context.blob',
          'tools.offered',
          'model.message',
        ]);
        const told = resumed.step.rows.at(-1);
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
        expect(warn).toHaveBeenCalledWith(
          'Tool "gone" was offered to this run but is no longer available; the resumed run continues without it.',
        );
        yield* closeSessionOf(session);
      }),
  );

  // Failure modes: a credential added mid-run (1) rewrites agent's
  // description, so its `shown` digest and the cached tools change; (2)
  // rewrites the frozen system text; (3) never reaches the model; (4)
  // reaches it as more than one line, or as the whole list again.
  it.effect(
    'a credential added mid-run leaves the delegation tool and system text as recorded and tells the model in one line',
    () =>
      Effect.gen(function* () {
        vi.stubEnv(apiKeyEnvName('deepseek'), '');
        const session = yield* sessionWithInteractions({ emit: () => {} });
        const runId = generateRunId();
        publishTestRunStart(session, runId);
        const config = AgentConfigSchema.parse({
          agent: 'chat',
          model: 'test-model',
          agentCategory: AgentCategory.ToolUse,
          workingDirectory: process.cwd(),
        });
        const launch = validationLaunch({ runId, session }, config);
        const ctx: AgentLaunchContext = {
          ...launch,
          setting: AgentSettingSchema.parse({
            agentCategory: AgentCategory.ToolUse,
            tools: [{ name: 'agent' }],
          }),
        };
        yield* runToolUse({ resume: false }).pipe(
          Effect.provide(runLayer(ctx, [])),
          Effect.orDie,
        );
        const before = (yield* session.ledger.load(runId))!;

        yield* ctx.stores.secrets.set(apiKeySecretName('deepseek'), 'sk-test');
        const step = yield* Effect.gen(function* () {
          return yield* stepFor(yield* AgentRun, before, false, 'request', {
            base: () => 'base',
            isChild: () => false,
            activated: () => [],
          });
        }).pipe(Effect.provide(runLayer(ctx, [])), Effect.orDie);

        const offered = step.rows.find((row) => row.type === 'tools.offered');
        assert(offered?.type === 'tools.offered');
        expect(offered.payload.tools).toEqual(before.offeredTools);
        expect(offered.payload.tools.some(({ name }) => name === 'agent')).toBe(
          true,
        );
        expect(offered.payload.system).toBe(before.offeredSystem);
        const told = step.rows.filter((row) => row.type === 'model.message');
        expect(told).toHaveLength(1);
        assert(told[0]?.type === 'model.message');
        expect(told[0].payload).toMatchObject({
          kind: 'append',
          messages: [
            {
              role: 'system',
              text: expect.stringMatching(
                /^Models for delegation now available: deepseek\/[^\n]*\.$/,
              ),
            },
          ],
        });
        yield* closeSessionOf(session);
      }),
  );

  // Failure modes: a plugin switched on mid-run (1) re-renders the script
  // tool's declarations, so its `shown` digest and the cached tools change;
  // (2) leaves the new tool uncallable from the step; (3) never reaches the
  // model; (4) reaches it as more than one line.
  it.effect(
    'a plugin switched on mid-run leaves the script description as frozen and tells the model in one line',
    () =>
      Effect.gen(function* () {
        const session = yield* sessionWithInteractions({ emit: () => {} });
        const runId = generateRunId();
        publishTestRunStart(session, runId);
        const config = AgentConfigSchema.parse({
          agent: 'chat',
          model: 'test-model',
          agentCategory: AgentCategory.ToolUse,
          workingDirectory: process.cwd(),
        });
        const ctx: AgentLaunchContext = {
          ...validationLaunch({ runId, session }, config),
          setting: AgentSettingSchema.parse({
            agentCategory: AgentCategory.ToolUse,
            tools: [
              { name: 'script' },
              { name: 'read_file' },
              { name: 'zotero_search' },
            ],
          }),
        };
        const switches = ctx.stores.globalState;
        yield* switches.update(GlobalStateKey.DISABLED_TOOLS, ['zotero']);
        yield* runToolUse({ resume: false }).pipe(
          Effect.provide(runLayer(ctx, [])),
          Effect.orDie,
        );
        const before = (yield* session.ledger.load(runId))!;

        const step = yield* Effect.gen(function* () {
          const run = yield* AgentRun;
          const system = {
            base: () => 'base',
            isChild: () => false,
            activated: () => [],
          };
          // The activation's first step is held to the record; the switch
          // reaches the one after it.
          yield* stepFor(run, before, false, 'request', system);
          yield* switches.update(GlobalStateKey.DISABLED_TOOLS, []);
          return yield* stepFor(run, before, false, 'request', system);
        }).pipe(Effect.provide(runLayer(ctx, [])), Effect.orDie);

        const offered = step.rows.find((row) => row.type === 'tools.offered');
        assert(offered?.type === 'tools.offered');
        const script = (tools: readonly { name: string; shown: string }[]) =>
          tools.find(({ name }) => name === 'script')?.shown;
        expect(script(offered.payload.tools)).toBeDefined();
        expect(script(offered.payload.tools)).toBe(
          script(before.offeredTools ?? []),
        );
        expect(step.tools.registry.has('zotero_search')).toBe(true);
        const told = step.rows.filter((row) => row.type === 'model.message');
        expect(told).toHaveLength(1);
        assert(told[0]?.type === 'model.message');
        expect(told[0].payload).toMatchObject({
          kind: 'append',
          messages: [
            {
              role: 'system',
              text: 'These tools are now available: zotero_search.',
            },
          ],
        });
        yield* closeSessionOf(session);
      }),
  );

  it.effect('filters approval-gated and host-excluded declared tools', () =>
    Effect.gen(function* () {
      // The run's tool policy carries both gates; `AgentRun` hands them to the
      // resolver when it builds the model-facing list.
      const resolved = yield* resolveTestStep({
        tools: AgentToolUseSettingSchema.parse({
          tools: [
            { name: 'bash' },
            { name: 'grep' },
            { name: 'inquiry' },
            { name: 'write_file' },
            { name: 'wolfram' },
          ],
        }).tools,
        approvalPromptsUnavailable: true,
        host: 'cli',
        // No conditional injections: this pins the declared-tool gates alone.
        injectTools: false,
        stores: hostStores(),
        workspaceRoot: undefined,
      }).pipe(
        Effect.scoped,
        Effect.provide(LanguageModel.layer(UNAVAILABLE_LANGUAGE_MODEL_PORT)),
        Effect.provide(
          toolTableLayer(
            toolTable([
              {
                id: 'test',
                name: 'Test',
                category: 'file',
                description: '',
                tools: {
                  bash: approvalGatedTool('bash'),
                  grep: tool('grep'),
                  inquiry: { ...tool('inquiry'), unavailableHosts: ['cli'] },
                  write_file: approvalGatedTool('write_file'),
                  wolfram: approvalGatedTool('wolfram'),
                },
              },
            ]),
          ).pipe(
            Layer.provide(
              Layer.merge(nodePlatformLayer, AppState.layer(fakeHostAppState)),
            ),
          ),
        ),
        Effect.provide(nodeSpawnerLayer),
      );

      expect(resolved.definitions.map(({ name }) => name)).toEqual(['grep']);
    }),
  );
});
