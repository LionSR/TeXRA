/* eslint-disable import/order -- Vitest mocks must be declared before importing the module under test. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { setupPlatform } from '@test/support/setupPlatform';
import { TraceEmitter } from '@agent/trace';
import { deriveWorkflowScriptCheckpointId } from '@agent/workflowScript';
import { ExecutionLeaseActiveError } from '@agent/storage';
import { withToolFileInteractionContext } from '@agent/followUp/ToolFileInteractionContext';
import type { LaunchRunContext } from '@agent/runtime/RunContext';
import { withRunContext } from '@agent/runtime/RunContext';
import type { ExecutionId, StreamTabId } from '@shared/schemas';
import {
  DELEGATION_AVAILABILITY_CATEGORY,
  DELEGATION_TOOL_CATEGORY,
  DELEGATION_TOOLS,
} from '@shared/constants/delegationTools';
import { deriveExecutionId } from '@utils/core/idHash';

setupPlatform({ storagePath: '/storage', workspacePath: '/workspace' });

const mocks = vi.hoisted(() => ({
  registerExecution: vi.fn(),
  startChildRunLoop: vi.fn(),
  createChildStream: vi.fn(),
  configureDelegatedChildApprovals: vi.fn(),
}));

// Spread the real storage module so `ExecutionLeaseActiveError`,
// `getExecutionStore`, and lease helpers stay authentic; only registration is
// spied so the launch can be observed without touching the async run loop.
vi.mock('@agent/storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent/storage')>();
  return { ...actual, registerExecution: mocks.registerExecution };
});

vi.mock('@agent/runtime/childRunLoop', () => ({
  startChildRunLoop: mocks.startChildRunLoop,
}));

vi.mock('@tools/childStream', () => ({
  createChildStream: mocks.createChildStream,
}));

vi.mock('@tools/approval', () => ({
  configureDelegatedChildApprovals: mocks.configureDelegatedChildApprovals,
}));

import { WorkflowScriptTool } from '@tools/delegation/WorkflowScriptTool';
import { getDefaultToolRegistry } from '@tools/registry';

const executionId = '7154scripttool' as ExecutionId;
const streamId = 'stream:workflow-script-tool' as StreamTabId;
const script = `export const meta = {
  name: 'tool-test',
  description: 'tests the workflow script tool',
}
return await agent('saved call')`;

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

/** The deterministic run executionId derived from that checkpoint identity. */
function runExecutionIdFor(name: string): ExecutionId {
  return deriveExecutionId({ checkpointId: checkpointIdFor(name) });
}

async function callTool(options?: {
  readonly script?: string;
  readonly recordCost?: (cost: number) => void;
}) {
  return withRunContext(parentContext(), () =>
    withToolFileInteractionContext(
      {
        tracker: {} as never,
        toolCallId: 'tool-call',
        trace: new TraceEmitter(),
        hooks: { recordSubagentCost: options?.recordCost ?? vi.fn() },
      },
      () =>
        new WorkflowScriptTool().call({
          agent: 'correct',
          script: options?.script ?? script,
        }),
    ),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.registerExecution.mockResolvedValue(undefined);
  mocks.createChildStream.mockImplementation((runId: ExecutionId): unknown => ({
    childStreamId: `workflow-script#${runId}` as StreamTabId,
    logger: new TraceEmitter(),
    waitForInput: vi.fn(),
    beginTurn: vi.fn(),
    failTurn: vi.fn(),
    finalize: vi.fn(),
  }));
});

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
    expect(mocks.startChildRunLoop).not.toHaveBeenCalled();
  });

  it('requires a launched tool context', async () => {
    const outside = await new WorkflowScriptTool().call({
      agent: 'correct',
      script,
    });
    expect(outside).toMatchObject({
      status: 'error',
      error: expect.stringContaining('active launched agent session'),
    });
    expect(mocks.startChildRunLoop).not.toHaveBeenCalled();
  });

  it('launches the run as a detached child with a deterministic run id', async () => {
    const result = await callTool();

    const runExecutionId = runExecutionIdFor('tool-test');
    // The run id is derived from the checkpoint identity (NOT random), so a
    // relaunch with the same meta.name re-roots at the same anchor and resume
    // still works (#8712).
    expect(mocks.registerExecution).toHaveBeenCalledWith(
      runExecutionId,
      expect.objectContaining({ agentCategory: 'workflow', agent: 'correct' }),
      'tool-test',
      executionId,
    );
    expect(mocks.createChildStream).toHaveBeenCalledWith(
      runExecutionId,
      streamId,
      expect.objectContaining({
        streamPrefix: 'workflow-script',
        streamCategory: 'workflow',
        agentName: 'tool-test',
      }),
    );
    // The run's own stream inherits the orchestrator's approval ancestry.
    expect(mocks.configureDelegatedChildApprovals).toHaveBeenCalledWith(
      `workflow-script#${runExecutionId}`,
      streamId,
      'inherit',
      expect.objectContaining({ id: 'workflow-script-test' }),
    );
    expect(mocks.startChildRunLoop).toHaveBeenCalledTimes(1);
    const loopParams = mocks.startChildRunLoop.mock.calls[0]?.[0];
    expect(loopParams).toMatchObject({
      childStreamId: `workflow-script#${runExecutionId}`,
      parentStreamId: streamId,
      executionId: runExecutionId,
      agentName: 'tool-test',
    });
    expect(loopParams.strategy).toMatchObject({
      stageLabel: "Workflow script 'tool-test'",
      launch: expect.any(Function),
      isTerminal: expect.any(Function),
    });
    // Terminal-only: no runTurn (matches the native workflow strategy shape).
    expect(loopParams.strategy.runTurn).toBeUndefined();
    expect(loopParams.recordCost).toEqual(expect.any(Function));

    expect(result).toMatchObject({
      status: 'executed',
      summary: "Launched workflow script 'tool-test' (async)",
    });
    expect(result.output).toContain(`Execution ID: ${runExecutionId}`);
    expect(result.output).toContain('same meta.name');
  });

  it('regenerates the same run id across relaunches of one meta.name', async () => {
    await callTool();
    const first = mocks.startChildRunLoop.mock.calls[0]?.[0].executionId;
    mocks.startChildRunLoop.mockClear();
    // A retrying model rewrites its source; the deterministic run id and the
    // meta.name-anchored checkpoint keep resume intact.
    await callTool({ script: `${script}\n// retry rewrote me` });
    const second = mocks.startChildRunLoop.mock.calls[0]?.[0].executionId;

    expect(first).toBe(runExecutionIdFor('tool-test'));
    expect(second).toBe(first);
  });

  it('reports already-running when the deterministic id is still leased', async () => {
    const runExecutionId = runExecutionIdFor('tool-test');
    mocks.registerExecution.mockRejectedValueOnce(
      new ExecutionLeaseActiveError(runExecutionId, Date.now()),
    );

    const result = await callTool();

    expect(result).toMatchObject({
      status: 'executed',
      summary: "Workflow script 'tool-test' is already running",
    });
    expect(result.output).toContain(`Execution ID: ${runExecutionId}`);
    // A relaunch over a live run never starts a second competing loop.
    expect(mocks.createChildStream).not.toHaveBeenCalled();
    expect(mocks.startChildRunLoop).not.toHaveBeenCalled();
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
});
