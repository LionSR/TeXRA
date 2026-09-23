import '@test/support/defaultSessionTestSetup';

import { it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { describe, expect, vi } from 'vitest';

import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import {
  AgentPromptSchema,
  AgentToolUseSettingSchema,
} from '@agent/core/definition/AgentDataclass';
import type { ITool } from '@agent/core/tools/ToolTypes';
import { resolveAgentTools } from '@agent/runtime/agentToolResolution';
import { followUpsLayer } from '@agent/runtime/FollowUps';
import type { AgentLaunchContext } from '@agent/runtime/AgentLaunchContext';
import { ModelInvoker, type InvokeRequest } from '@agent/runtime/ModelInvoker';
import { runToolUse } from '@agent/runtime/loop/toolUse';
import { AgentRun, agentRunLayer } from '@agent/runtime/run/AgentRun';
import {
  LanguageModel,
  UNAVAILABLE_LANGUAGE_MODEL_PORT,
} from '@platform/languageModel';
import { AgentCategory } from '@shared/schemas';
import { RunLedger } from '@shared/session/runLedger';
import { noopTrace } from '@test/support/noopTrace';
import { nativeToolTestLayer } from '@test/support/nativeToolTestLayer';
import { testHttpClientLayer } from '@test/support/fetchTestUtils';
import { hostStores, setupPlatform } from '@test/support/setupPlatform';
import { buildTestModelConfig } from '@test/support/modelConfigTestUtils';
import { publishTestRunStart } from '@test/support/sessionTestUtils';
import { toolRegistryLayer } from '@tools/registry';
import { ToolRegistry, toolTable } from '@tools/toolTable';
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

/**
 * A launch whose model binds without a credential: the run layer reads the
 * compatibility key off the launch context, and the validation key binds the
 * deterministic in-process model.
 */
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
    modelCompatibilityKey: 'Validation',
  };
}

/** A model that records the tools it was offered and then stops the run. */
function observingInvokerLayer(seen: InvokeRequest[]) {
  return Layer.succeed(ModelInvoker, {
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
    followUpsLayer,
    nativeToolTestLayer(),
  ).pipe(
    Layer.provideMerge(
      agentRunLayer(ctx, { tools, callbacks: { onModelChanged: () => {} } }),
    ),
    Layer.provideMerge(Layer.succeed(RunLedger, ctx.session.ledger)),
    Layer.provideMerge(LanguageModel.layer(UNAVAILABLE_LANGUAGE_MODEL_PORT)),
    Layer.provideMerge(testHttpClientLayer),
    Layer.provideMerge(toolRegistryLayer),
  );
}

describe('run-scoped tool resolution', () => {
  setupPlatform({ workspacePath: process.cwd() });

  it.effect(
    'adds the run-scoped tools and submit_output to the model-facing list',
    () =>
      Effect.gen(function* () {
        const session = sessionWithInteractions({ emit: () => {} });
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
          return (yield* AgentRun).tools;
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
        yield* session.dispose();
      }),
  );

  it.effect(
    'resumes with the recorded tools that still resolve and names each one gone',
    () =>
      Effect.gen(function* () {
        const session = sessionWithInteractions({ emit: () => {} });
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
          return yield* AgentRun;
        }).pipe(
          Effect.provide(runLayer(ctx, [tool('kept'), tool('added')])),
          Effect.orDie,
        );

        expect(resumed.setting.tools.map(({ name }) => name)).toEqual([
          'memory',
          'plan',
          'kept',
        ]);
        expect(resumed.tools.has('gone')).toBe(false);
        expect(resumed.tools.has('added')).toBe(false);
        expect(resumed.toolset.offeredTools).toEqual([
          'memory',
          'plan',
          'gone',
          'kept',
        ]);
        expect(warn).toHaveBeenCalledWith(
          'Tool "gone" was offered to this run but is no longer available; the resumed run continues without it.',
        );
        yield* session.dispose();
      }),
  );

  it.effect('filters approval-gated and host-excluded declared tools', () =>
    Effect.gen(function* () {
      // The run's tool policy carries both gates; `AgentRun` hands them to the
      // resolver when it builds the model-facing list.
      const resolved = yield* resolveAgentTools({
        tools: AgentToolUseSettingSchema.parse({
          tools: [
            { name: 'bash' },
            { name: 'grep' },
            { name: 'inquiry' },
            { name: 'write_file' },
            { name: 'wolfram' },
          ],
        }).tools,
        logger: noopTrace,
        approvalPromptsUnavailable: true,
        host: 'cli',
        // No conditional injections: this pins the declared-tool gates alone.
        injectTools: false,
        stores: hostStores(),
        workspaceRoot: undefined,
      }).pipe(
        Effect.provide(LanguageModel.layer(UNAVAILABLE_LANGUAGE_MODEL_PORT)),
        Effect.provide(
          Layer.succeed(ToolRegistry)(
            toolTable({
              test: {
                bash: approvalGatedTool('bash'),
                grep: tool('grep'),
                inquiry: { ...tool('inquiry'), unavailableHosts: ['cli'] },
                write_file: approvalGatedTool('write_file'),
                wolfram: approvalGatedTool('wolfram'),
              },
            }),
          ),
        ),
      );

      expect(resolved.definitions.map(({ name }) => name)).toEqual(['grep']);
    }),
  );
});
