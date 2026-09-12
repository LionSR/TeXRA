import '@test/support/defaultSessionTestSetup';

import { it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { describe, expect, vi } from 'vitest';

import { noopTrace } from '@agent/trace';
import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import {
  AgentPromptSchema,
  AgentToolUseSettingSchema,
} from '@agent/core/definition/AgentDataclass';
import { MapToolRegistry, type ITool } from '@agent/core/tools/ToolTypes';
import { resolveAgentTools } from '@agent/runtime/agentToolResolution';
import { followUpsLayer } from '@agent/runtime/FollowUps';
import type { AgentLaunchContext } from '@agent/runtime/AgentLaunchContext';
import { ModelInvoker, type InvokeRequest } from '@agent/runtime/ModelInvoker';
import { runToolUse } from '@agent/runtime/loop/toolUse';
import { agentRunLayer } from '@agent/runtime/run/AgentRun';
import { ToolInjectionRegistry } from '@agent/runtime/toolInjection';
import { AgentCategory } from '@shared/schemas';
import { RunLedger } from '@shared/session/runLedger';
import { hostStores, setupPlatform } from '@test/support/setupPlatform';
import { buildTestModelConfig } from '@test/support/modelConfigTestUtils';
import { publishTestRunStart } from '@test/support/sessionTestUtils';
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
    invoke: (state, request) =>
      Effect.sync(() => {
        seen.push(request);
        return { kind: 'cancelled' as const, state };
      }),
  });
}

describe('run-scoped tool resolution', () => {
  setupPlatform({ workspacePath: process.cwd() });

  it.effect(
    'adds the run-scoped tools and submit_output to the model-facing list',
    () =>
      Effect.gen(function* () {
        const session = sessionWithInteractions({
          emit: () => {},
          cancel: () => {},
        });
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

        yield* runToolUse({ resume: false }).pipe(
          Effect.provide(
            Layer.mergeAll(observingInvokerLayer(seen), followUpsLayer).pipe(
              Layer.provideMerge(
                agentRunLayer(ctx, {
                  setting: ctx.setting,
                  parentRunId: null,
                  // Run-scoped tools, one of them shadowing a registered tool.
                  tools: [tool('bash'), tool('second')],
                  toolInjections: new ToolInjectionRegistry(),
                  callbacks: { onModelChanged: () => {} },
                  inScope: (operation) => operation(),
                }),
              ),
              Layer.provideMerge(Layer.succeed(RunLedger, session.ledger)),
            ),
          ),
          Effect.orDie,
        );

        // The overlay tools and the synthetic terminal tool are what the model
        // is offered, in overlay order.
        expect(seen[0]?.tools?.map(({ name }) => name)).toEqual([
          'bash',
          'second',
          'submit_output',
        ]);
        expect(warn).toHaveBeenCalledWith(
          'Run-scoped tool "bash" shadows an existing tool.',
        );
        session.dispose();
      }),
  );

  it('filters approval-gated and runtime-unavailable declared tools', async () => {
    // The run's tool policy carries both gates; `AgentRun` hands them to the
    // resolver when it builds the model-facing list.
    const resolved = await resolveAgentTools({
      tools: AgentToolUseSettingSchema.parse({
        tools: [
          { name: 'bash' },
          { name: 'grep' },
          { name: 'inquiry' },
          { name: 'write_file' },
          { name: 'wolfram' },
        ],
      }).tools,
      registry: new MapToolRegistry({
        bash: approvalGatedTool('bash'),
        grep: tool('grep'),
        inquiry: approvalGatedTool('inquiry'),
        write_file: approvalGatedTool('write_file'),
        wolfram: approvalGatedTool('wolfram'),
      }),
      logger: noopTrace,
      approvalPromptsUnavailable: true,
      runtimeUnavailableTools: ['inquiry'],
      // No conditional injections: this pins the declared-tool gates alone.
      toolInjections: new ToolInjectionRegistry(),
      stores: hostStores(),
    });

    expect(resolved.map(({ name }) => name)).toEqual(['grep']);
  });
});
