import { beforeEach, describe, expect, it, vi } from 'vitest';

import { clearStoreCache, getExecutionStore } from '@agent/storage';
import { TraceEmitter, type AgentEvent } from '@agent/trace';
import {
  WorkflowRunAbortError,
  type WorkflowAgentInvocation,
} from '@agent/workflowScript';
import { RUN_OUTCOME, type ExecutionId } from '@shared/schemas';
import { setupPlatform } from '@test/support/setupPlatform';
import { runPersistedWorkflowScriptWithProgress } from '@tools/delegation/workflowScriptRun';

const executionId = '7154progress' as ExecutionId;
const meta = `export const meta = {
  name: 'progress-test',
  description: 'tests workflow progress projection',
}`;

setupPlatform({ storagePath: '/storage', workspacePath: '/workspace' });

function recordingTrace(): {
  readonly trace: TraceEmitter;
  readonly events: AgentEvent[];
} {
  const trace = new TraceEmitter();
  const events: AgentEvent[] = [];
  trace.subscribe((event) => events.push(event));
  return { trace, events };
}

function stageId(events: readonly AgentEvent[], label: string): string {
  const event = events.find(
    (candidate) =>
      candidate.type === 'stage.start' && candidate.label === label,
  );
  if (event?.type !== 'stage.start') throw new Error(`Missing stage: ${label}`);
  return event.id;
}

function workflowTaskEvent(
  events: readonly AgentEvent[],
  label: string,
  status: string,
): Extract<AgentEvent, { type: 'workflow.task' }> | undefined {
  return events.find(
    (event): event is Extract<AgentEvent, { type: 'workflow.task' }> =>
      event.type === 'workflow.task' &&
      event.task.label === label &&
      event.task.status === status,
  );
}

beforeEach(() => clearStoreCache());

describe('workflow-script progress bridge', () => {
  it('projects phases and logs under the captured parent stage', async () => {
    const { trace, events } = recordingTrace();
    const parent = trace.openStage('Parent');
    const plannedMeta = `export const meta = {
  name: 'planned-progress-test',
  description: 'tests planned workflow progress projection',
  phases: [{ title: 'Research' }, { title: 'Write' }],
  tasks: [{ id: 'inspect', label: 'Inspect source', phase: 'Research' }],
}`;

    await parent.within(() =>
      runPersistedWorkflowScriptWithProgress(trace, {
        store: getExecutionStore(executionId),
        checkpointId: 'phase-log',
        script: `${plannedMeta}
log('Preparing the workflow')
phase('Research')
log('Checking the source')
return await agent('Inspect', { id: 'inspect' })`,
        runAgent: async () => 'done',
      }),
    );

    const phaseId = stageId(events, 'Research');
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'log',
        message: 'Preparing the workflow',
        stageId: parent.id,
      }),
    );
    const planned = workflowTaskEvent(events, 'Inspect source', 'planned');
    const completed = workflowTaskEvent(events, 'Inspect source', 'completed');
    expect(planned).toMatchObject({
      type: 'workflow.task',
      stageId: parent.id,
    });
    expect(completed).toMatchObject({
      type: 'workflow.task',
      logId: planned?.logId,
      stageId: phaseId,
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'stage.start',
        id: phaseId,
        parentId: parent.id,
        kind: 'phase',
        index: 0,
        total: 2,
      }),
    );
    expect(events.some((event) => event.type === 'child.activity')).toBe(false);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'log',
        message: 'Checking the source',
        stageId: phaseId,
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'stage.end',
        id: phaseId,
        status: RUN_OUTCOME.COMPLETED,
      }),
    );
  });

  it('marks declared tasks not reached by the script as skipped', async () => {
    const { trace, events } = recordingTrace();
    await runPersistedWorkflowScriptWithProgress(trace, {
      store: getExecutionStore(executionId),
      checkpointId: 'not-reached-plan',
      script: `export const meta = {
  name: 'conditional-plan',
  description: 'declares all possible work',
  phases: [{ title: 'Research' }],
  tasks: [
    { id: 'used', label: 'Used task', phase: 'Research' },
    { id: 'unused', label: 'Unused task', phase: 'Research' },
  ],
}
phase('Research')
return await agent('Run one', { id: 'used' })`,
      runAgent: async () => 'done',
    });

    const researchStageId = stageId(events, 'Research');
    expect(workflowTaskEvent(events, 'Used task', 'completed')).toBeDefined();
    expect(workflowTaskEvent(events, 'Unused task', 'skipped')).toMatchObject({
      stageId: researchStageId,
      task: {
        reason: 'not-reached',
      },
    });
  });

  it('projects a cached completion without synthesizing a start event', async () => {
    const store = getExecutionStore(executionId);
    const script = `${meta}
return await agent('Read', { phase: 'Review' })`;
    await runPersistedWorkflowScriptWithProgress(recordingTrace().trace, {
      store,
      checkpointId: 'cached',
      script,
      runAgent: async () => 'saved',
    });

    clearStoreCache();
    const { trace, events } = recordingTrace();
    const runner = vi.fn(() => Promise.reject(new Error('must not run')));
    await runPersistedWorkflowScriptWithProgress(trace, {
      store: getExecutionStore(executionId),
      checkpointId: 'cached',
      runAgent: runner,
    });

    const phaseId = stageId(events, 'Review');
    expect(runner).not.toHaveBeenCalled();
    expect(workflowTaskEvent(events, 'Read', 'cached')).toMatchObject({
      type: 'workflow.task',
      stageId: phaseId,
    });
    expect(workflowTaskEvent(events, 'Read', 'running')).toBeUndefined();
  });

  it('keeps phase counts when an agent opens the stage before phase()', async () => {
    const { trace, events } = recordingTrace();
    const script = `export const meta = {
  name: 'early-phase-agent',
  description: 'opens a declared phase from an agent event',
  phases: [{ title: 'Research' }, { title: 'Write' }],
}
const early = agent('Draft', { phase: 'Write' })
phase('Write')
return await early`;

    await runPersistedWorkflowScriptWithProgress(trace, {
      store: getExecutionStore(executionId),
      checkpointId: 'early-phase-agent',
      script,
      runAgent: async () => 'done',
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'stage.start',
        id: stageId(events, 'Write'),
        kind: 'phase',
        index: 1,
        total: 2,
      }),
    );
  });

  it('renders the running total on live finish lines only', async () => {
    const store = getExecutionStore(executionId);
    const script = `${meta}
await agent('First')
return await agent('Second')`;
    const { trace, events } = recordingTrace();
    let liveCostUsd = 0;
    await runPersistedWorkflowScriptWithProgress(trace, {
      store,
      checkpointId: 'live-cost',
      script,
      runAgent: async () => {
        liveCostUsd += 0.05;
        return 'done';
      },
      getLiveCostUsd: () => liveCostUsd,
    });

    expect(workflowTaskEvent(events, 'First', 'completed')?.task).toMatchObject(
      {
        totalCostUsd: 0.05,
      },
    );
    expect(
      workflowTaskEvent(events, 'Second', 'completed')?.task,
    ).toMatchObject({
      totalCostUsd: 0.1,
    });

    clearStoreCache();
    const replay = recordingTrace();
    await runPersistedWorkflowScriptWithProgress(replay.trace, {
      store: getExecutionStore(executionId),
      checkpointId: 'live-cost',
      script,
      runAgent: vi.fn(() => Promise.reject(new Error('must not run'))),
      getLiveCostUsd: () => 0,
    });

    expect(
      workflowTaskEvent(replay.events, 'First', 'cached')?.task,
    ).not.toHaveProperty('totalCostUsd');
  });

  it('enriches live finish lines with the reported model and duration', async () => {
    const { trace, events } = recordingTrace();
    let liveCostUsd = 0;
    await runPersistedWorkflowScriptWithProgress(trace, {
      store: getExecutionStore(executionId),
      checkpointId: 'model-duration',
      script: `${meta}
return await agent('Draft')`,
      runAgent: async (invocation: WorkflowAgentInvocation) => {
        invocation.reportModel?.('deepseekT');
        liveCostUsd += 0.02;
        return 'done';
      },
      getLiveCostUsd: () => liveCostUsd,
    });

    expect(workflowTaskEvent(events, 'Draft', 'completed')?.task).toMatchObject(
      {
        model: 'deepseekT',
        durationMs: expect.any(Number),
        totalCostUsd: 0.02,
      },
    );
  });

  it('marks a phase failed when an agent call fails', async () => {
    const { trace, events } = recordingTrace();
    await runPersistedWorkflowScriptWithProgress(trace, {
      store: getExecutionStore(executionId),
      checkpointId: 'agent-failure',
      script: `${meta}
phase('Analysis')
return await agent('Unsuccessful')`,
      runAgent: async () => {
        throw new Error('model unavailable');
      },
    });

    const phaseId = stageId(events, 'Analysis');
    expect(workflowTaskEvent(events, 'Unsuccessful', 'failed')).toMatchObject({
      type: 'workflow.task',
      stageId: phaseId,
      task: {
        error: 'model unavailable',
      },
    });
    expect(events).toContainEqual({
      type: 'stage.end',
      id: phaseId,
      status: RUN_OUTCOME.FAILED,
    });
  });

  it('keeps out-of-order parallel completions in their starting phases', async () => {
    const { trace, events } = recordingTrace();
    const pending = new Map<string, (value: string) => void>();
    const runAgent = vi.fn(
      ({ prompt }: WorkflowAgentInvocation) =>
        new Promise<string>((resolve) => pending.set(prompt, resolve)),
    );
    const run = runPersistedWorkflowScriptWithProgress(trace, {
      store: getExecutionStore(executionId),
      checkpointId: 'parallel-phases',
      script: `${meta}
return await parallel([
  () => agent('slow', { phase: 'First' }),
  () => agent('fast', { phase: 'Second' }),
])`,
      runAgent,
    });

    await vi.waitFor(() => expect(runAgent).toHaveBeenCalledTimes(2));
    pending.get('fast')?.('fast result');
    pending.get('slow')?.('slow result');
    await run;

    const firstId = stageId(events, 'First');
    const secondId = stageId(events, 'Second');
    expect(workflowTaskEvent(events, 'slow', 'completed')).toMatchObject({
      stageId: firstId,
    });
    expect(workflowTaskEvent(events, 'fast', 'completed')).toMatchObject({
      stageId: secondId,
    });
  });

  it('does not move an unphased live call into a later phase', async () => {
    const { trace, events } = recordingTrace();
    await runPersistedWorkflowScriptWithProgress(trace, {
      store: getExecutionStore(executionId),
      checkpointId: 'late-phase',
      script: `${meta}
const pending = agent('before phase')
phase('Later')
return await pending`,
      runAgent: async () => 'done',
    });

    const completion = workflowTaskEvent(events, 'before phase', 'completed');
    expect(completion).toMatchObject({
      type: 'workflow.task',
      stageId: undefined,
    });
    expect(completion).not.toMatchObject({ stageId: stageId(events, 'Later') });
  });

  it('closes a started phase when the runner aborts without an end event', async () => {
    const { trace, events } = recordingTrace();
    await expect(
      runPersistedWorkflowScriptWithProgress(trace, {
        store: getExecutionStore(executionId),
        checkpointId: 'runner-abort',
        script: `${meta}
return await agent('Abort', { phase: 'Execution' })`,
        runAgent: async () => {
          throw new WorkflowRunAbortError('fatal runner error');
        },
      }),
    ).rejects.toThrow('fatal runner error');

    const phaseId = stageId(events, 'Execution');
    expect(workflowTaskEvent(events, 'Abort', 'failed')).toMatchObject({
      stageId: phaseId,
      task: {
        error: 'The workflow ended before this task completed.',
      },
    });
    expect(events).toContainEqual({
      type: 'stage.end',
      id: phaseId,
      status: RUN_OUTCOME.FAILED,
    });
  });

  it('closes every opened phase after a script failure', async () => {
    const { trace, events } = recordingTrace();
    await expect(
      runPersistedWorkflowScriptWithProgress(trace, {
        store: getExecutionStore(executionId),
        checkpointId: 'script-failure',
        script: `${meta}
phase('One')
log('first')
phase('Two')
throw new Error('script failed')`,
        runAgent: async () => 'unused',
      }),
    ).rejects.toThrow('script failed');

    for (const label of ['One', 'Two']) {
      expect(events).toContainEqual({
        type: 'stage.end',
        id: stageId(events, label),
        status: RUN_OUTCOME.FAILED,
      });
    }
  });
});
