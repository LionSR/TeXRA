import { beforeEach, describe, expect, it, vi } from 'vitest';

import { setupPlatform } from '@test/support/setupPlatform';
import { clearStoreCache, getExecutionStore } from '@agent/storage';
import { TraceEmitter } from '@agent/trace';
import {
  deriveWorkflowScriptCheckpointId,
  runPersistedWorkflowScript,
} from '@agent/workflowScript';
import { withToolFileInteractionContext } from '@agent/followUp/ToolFileInteractionContext';
import type { AgentFinalResult } from '@agent/runtime/AgentFinalResult';
import type { LaunchRunContext } from '@agent/runtime/RunContext';
import { withRunContext } from '@agent/runtime/RunContext';
import type { ExecutionId, StreamTabId } from '@shared/schemas';
import {
  DELEGATION_AVAILABILITY_CATEGORY,
  DELEGATION_TOOL_CATEGORY,
  DELEGATION_TOOLS,
} from '@shared/constants/delegationTools';
import { getDefaultToolRegistry } from '@tools/registry';
import { WorkflowScriptTool } from '@tools/delegation/WorkflowScriptTool';

setupPlatform({ storagePath: '/storage', workspacePath: '/workspace' });

const executionId = '7154scripttool' as ExecutionId;
const streamId = 'stream:workflow-script-tool' as StreamTabId;
const script = `export const meta = {
  name: 'tool-test',
  description: 'tests the workflow script tool',
}
return await agent('saved call')`;
const finalResult: AgentFinalResult = {
  category: 'workflow',
  outcome: 'completed',
  outputs: [],
  compileFailures: [],
  diffs: [],
  cost: 0.42,
};

function parentContext(): LaunchRunContext {
  return {
    kind: 'launch',
    model: 'parent-model',
    runScope: {
      executionId,
      streamId,
      agentName: 'orchestrator',
      runtimeHost: { emit: vi.fn() } as never,
      session: { id: 'workflow-script-test' } as never,
    },
  };
}

/** The tool's durable identity for one meta.name under the test parent. */
function checkpointIdFor(name: string): string {
  return deriveWorkflowScriptCheckpointId({
    name,
    defaultAgent: 'correct',
    parentExecutionId: executionId,
  });
}

async function callTool(options?: {
  readonly toolCallId?: string;
  readonly script?: string;
  readonly recordCost?: (cost: number) => void;
  readonly signal?: AbortSignal;
  readonly trace?: TraceEmitter;
  readonly args?: unknown;
}) {
  return withRunContext(parentContext(), () =>
    withToolFileInteractionContext(
      {
        tracker: {} as never,
        toolCallId: options?.toolCallId ?? 'tool-call',
        trace: options?.trace ?? new TraceEmitter(),
        signal: options?.signal,
        hooks: { recordSubagentCost: options?.recordCost ?? vi.fn() },
      },
      () =>
        new WorkflowScriptTool().call({
          agent: 'correct',
          script: options?.script ?? script,
          ...(options &&
            Object.hasOwn(options, 'args') && { args: options.args }),
        }),
    ),
  );
}

beforeEach(() => clearStoreCache());

describe('WorkflowScriptTool', () => {
  it('is registered and classified without becoming a proposal tool', () => {
    expect(getDefaultToolRegistry().has('delegate_workflow_script')).toBe(true);
    expect(DELEGATION_TOOLS.has('delegate_workflow_script')).toBe(true);
    expect(DELEGATION_AVAILABILITY_CATEGORY.delegate_workflow_script).toBe(
      'workflow',
    );
    expect(DELEGATION_TOOL_CATEGORY.delegate_workflow_script).toBeUndefined();
  });

  it('rejects invalid JSON arguments at the schema boundary', async () => {
    const result = await new WorkflowScriptTool().call({
      agent: 'correct',
      script,
      args: { invalid: undefined },
    });

    expect(result.status).toBe('error');
    expect(result.diagnostics).toMatchObject({ type: 'validation_error' });
  });

  it('requires a launched tool context and parent trace', async () => {
    const outside = await new WorkflowScriptTool().call({
      agent: 'correct',
      script,
    });
    expect(outside).toMatchObject({
      status: 'error',
      error: expect.stringContaining('active launched agent session'),
    });

    const missingTrace = await withRunContext(parentContext(), () =>
      withToolFileInteractionContext(
        { tracker: {} as never, toolCallId: 'missing-trace' },
        () => new WorkflowScriptTool().call({ agent: 'correct', script }),
      ),
    );
    expect(missingTrace).toMatchObject({
      status: 'error',
      error: expect.stringContaining('parent progress trace'),
    });
  });

  it('resumes a named checkpoint even when the retry rewrites the script', async () => {
    await runPersistedWorkflowScript({
      store: getExecutionStore(executionId),
      checkpointId: checkpointIdFor('tool-test'),
      script,
      runAgent: async () => finalResult,
    });
    clearStoreCache();
    const recordCost = vi.fn();

    const result = await callTool({ toolCallId: 'attempt-1', recordCost });

    expect(result).toMatchObject({
      status: 'executed',
      summary: "Completed workflow script 'tool-test' (1 agent call)",
    });
    expect(result.output).toContain('"category": "workflow"');
    // The run log rides along so the invoking model sees what executed.
    expect(result.output).toContain('=== Run log ===');
    expect(result.output).toContain('Using saved result');
    // Delta accounting: replayed entries were settled by the attempt that
    // executed them, so a pure replay settles zero instead of double-billing.
    expect(recordCost).toHaveBeenCalledTimes(1);
    expect(recordCost).toHaveBeenCalledWith(0);

    // A retrying model rewrites its source; same meta.name still resumes,
    // and the unchanged agent() call replays instead of re-executing.
    clearStoreCache();
    const retryCost = vi.fn();
    const retry = await callTool({
      toolCallId: 'attempt-2',
      recordCost: retryCost,
      script: `${script}\n// retry rewrote me`,
    });
    expect(retry).toMatchObject({ status: 'executed' });
    expect(retry.output).toContain('Using saved result');
    expect(retryCost).toHaveBeenCalledWith(0);
  });

  it('derives distinct checkpoints when name or default agent differ', () => {
    const base = checkpointIdFor('tool-test');
    expect(checkpointIdFor('other-name')).not.toBe(base);
    expect(
      deriveWorkflowScriptCheckpointId({
        name: 'tool-test',
        defaultAgent: 'merge',
        parentExecutionId: executionId,
      }),
    ).not.toBe(base);
  });

  it('passes JSON arguments through and formats a zero-call result', async () => {
    const recordCost = vi.fn();
    const result = await callTool({
      script: `export const meta = {
  name: 'arguments',
  description: 'returns its arguments',
}
return args`,
      args: { question: 'What is conserved?' },
      recordCost,
    });

    expect(result).toMatchObject({
      status: 'executed',
      summary: "Completed workflow script 'arguments' (0 agent calls)",
      output: expect.stringContaining('"question": "What is conserved?"'),
    });
    expect(recordCost).toHaveBeenCalledTimes(1);
    expect(recordCost).toHaveBeenCalledWith(0);
  });

  it('retains checkpoint arguments for null retries and replaces explicit values', async () => {
    const argsScript = `export const meta = {
  name: 'retained-arguments',
  description: 'retains omitted retry arguments',
}
return args`;
    await runPersistedWorkflowScript({
      store: getExecutionStore(executionId),
      checkpointId: checkpointIdFor('retained-arguments'),
      script: argsScript,
      args: { topic: 'geometry' },
      runAgent: async () => finalResult,
    });
    clearStoreCache();

    const result = await callTool({
      script: `${argsScript}\n// revised retry`,
      args: null,
    });

    expect(result).toMatchObject({
      status: 'executed',
      output: expect.stringContaining('"topic": "geometry"'),
    });

    clearStoreCache();
    const replacement = await callTool({
      script: `${argsScript}\n// retry with replacement arguments`,
      args: { topic: 'analysis' },
    });

    expect(replacement).toMatchObject({
      status: 'executed',
      output: expect.stringContaining('"topic": "analysis"'),
    });
  });

  it('bounds and normalizes the model-visible run log', async () => {
    const result = await callTool({
      script: `export const meta = {
  name: 'bounded-log',
  description: 'bounds model-visible activity',
}
for (let index = 0; index < 100; index += 1) log('line-' + index)
log('oversized\\n' + 'x'.repeat(2_000))
return 'done'`,
    });

    expect(result).toMatchObject({ status: 'executed' });
    expect(result.output).toContain(
      '=== Run log (last 80 lines; 21 earlier lines omitted) ===',
    );
    expect(result.output).not.toContain('line-20\n');
    expect(result.output).toContain('line-21\n');
    expect(result.output).toContain('oversized x');
    expect(result.output).not.toContain('oversized\n');
    expect(result.output?.length).toBeLessThan(42_000);
  });

  it('settles a retained journal when later script code fails', async () => {
    const failingScript = `export const meta = {
  name: 'retained-settlement',
  description: 'tests retained journal settlement',
}
await agent('saved call')
throw new Error('script failed after replay')`;
    await expect(
      runPersistedWorkflowScript({
        store: getExecutionStore(executionId),
        checkpointId: checkpointIdFor('retained-settlement'),
        script: failingScript,
        runAgent: async () => finalResult,
      }),
    ).rejects.toThrow('script failed after replay');
    clearStoreCache();
    const recordCost = vi.fn();

    const result = await callTool({
      recordCost,
      script: failingScript,
    });

    expect(result).toMatchObject({
      status: 'error',
      error: expect.stringContaining('script failed after replay'),
    });
    // Failures carry the run log and the resume hint back to the model.
    expect(result.error).toContain(
      "journaled under meta.name 'retained-settlement'",
    );
    // The seeding attempt journaled the entry; this attempt only replays it.
    expect(recordCost).toHaveBeenCalledTimes(1);
    expect(recordCost).toHaveBeenCalledWith(0);
  });

  it('fails closed on malformed journal costs without recording a scalar', async () => {
    // Distinct meta.name so this journal cannot alias the replay test's key.
    const malformedScript = `export const meta = {
  name: 'malformed-cost',
  description: 'tests malformed journal cost settlement',
}
return await agent('saved call')`;
    await runPersistedWorkflowScript({
      store: getExecutionStore(executionId),
      checkpointId: checkpointIdFor('malformed-cost'),
      script: malformedScript,
      runAgent: async () => ({ not: 'an agent result' }),
    });
    clearStoreCache();
    const recordCost = vi.fn();

    const result = await callTool({ recordCost, script: malformedScript });

    expect(result).toMatchObject({
      status: 'error',
      error: expect.stringContaining(
        'Workflow journal entry 0 is not an agent final result',
      ),
    });
    expect(recordCost).not.toHaveBeenCalled();
  });
});
