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

/** The tool's durable identity for a script+args pair under the test parent. */
function checkpointIdFor(scriptSource: string, args?: unknown): string {
  return deriveWorkflowScriptCheckpointId({
    script: scriptSource,
    args,
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
          args: options?.args,
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

  it('replays a content-keyed checkpoint across distinct tool-call ids', async () => {
    await runPersistedWorkflowScript({
      store: getExecutionStore(executionId),
      checkpointId: checkpointIdFor(script),
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
    expect(recordCost).toHaveBeenCalledTimes(1);
    expect(recordCost).toHaveBeenCalledWith(0.42);

    // A retry mints a new tool-call id; identical content resumes the journal.
    clearStoreCache();
    const retryCost = vi.fn();
    const retry = await callTool({
      toolCallId: 'attempt-2',
      recordCost: retryCost,
    });
    expect(retry).toMatchObject({ status: 'executed' });
    expect(retryCost).toHaveBeenCalledWith(0.42);
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

  it('settles a retained journal when later script code fails', async () => {
    const failingScript = `export const meta = {
  name: 'tool-test',
  description: 'tests retained journal settlement',
}
await agent('saved call')
throw new Error('script failed after replay')`;
    await expect(
      runPersistedWorkflowScript({
        store: getExecutionStore(executionId),
        checkpointId: checkpointIdFor(failingScript),
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
    expect(recordCost).toHaveBeenCalledTimes(1);
    expect(recordCost).toHaveBeenCalledWith(0.42);
  });

  it('fails closed on malformed journal costs without recording a scalar', async () => {
    // Distinct script so this journal cannot alias the replay test's content key.
    const malformedScript = `export const meta = {
  name: 'tool-test',
  description: 'tests malformed journal cost settlement',
}
return await agent('saved call')`;
    await runPersistedWorkflowScript({
      store: getExecutionStore(executionId),
      checkpointId: checkpointIdFor(malformedScript),
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
