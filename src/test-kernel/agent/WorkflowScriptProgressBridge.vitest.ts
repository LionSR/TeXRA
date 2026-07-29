import { beforeEach, describe, expect, it, vi } from 'vitest';

import { clearStoreCache, getExecutionStore } from '@agent/storage';
import { TraceEmitter, type AgentEvent } from '@agent/trace';
import {
  WorkflowRunAbortError,
  type WorkflowAgentInvocation,
  type WorkflowScriptControl,
} from '@agent/workflowScript';
import {
  RUN_OUTCOME,
  type ExecutionId,
  type StreamTabId,
  type WorkflowCallProgress,
} from '@shared/schemas';
import { workflowPhaseCallProgress } from '@shared/copy/workflowCall';
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

function workflowCallEvent(
  events: readonly AgentEvent[],
  label: string,
  status: WorkflowCallProgress['status'],
): Extract<AgentEvent, { type: 'workflow.task' }> | undefined {
  return events.find(
    (event): event is Extract<AgentEvent, { type: 'workflow.task' }> =>
      event.type === 'workflow.task' &&
      event.task.label === label &&
      event.task.status === status,
  );
}

/**
 * The current card set, one entry per `logId` — what a host progress tree
 * holds after applying every update.
 */
function latestWorkflowCallEvents(
  events: readonly AgentEvent[],
): Extract<AgentEvent, { type: 'workflow.task' }>[] {
  const byLogId = new Map<
    string,
    Extract<AgentEvent, { type: 'workflow.task' }>
  >();
  for (const event of events) {
    if (event.type === 'workflow.task') byLogId.set(event.logId, event);
  }
  return [...byLogId.values()];
}

beforeEach(() => clearStoreCache());

describe('workflow-script progress bridge', () => {
  it('keeps planned call cards in their phase stage across incremental updates', async () => {
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
    const planned = workflowCallEvent(events, 'Inspect source', 'planned');
    const running = workflowCallEvent(events, 'Inspect source', 'running');
    const completed = workflowCallEvent(events, 'Inspect source', 'completed');
    // One stable, phase-derived stage across the whole lifecycle: the card is
    // classified into its phase group when it is planned and never moves.
    expect(planned).toMatchObject({
      type: 'workflow.task',
      stageId: phaseId,
    });
    expect(running).toMatchObject({
      type: 'workflow.task',
      logId: planned?.logId,
      stageId: phaseId,
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
    const activities: string[] = [];
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
      onActivity: (line) => activities.push(line),
    });

    const unusedPlanned = workflowCallEvent(events, 'Unused task', 'planned');
    expect(workflowCallEvent(events, 'Used task', 'completed')).toBeDefined();
    expect(workflowCallEvent(events, 'Unused task', 'skipped')).toMatchObject({
      logId: unusedPlanned?.logId,
      stageId: unusedPlanned?.stageId,
      task: {
        reason: 'not-reached',
      },
    });
    expect(activities).toContain(
      'Skipped: Unused task — The workflow ended before this call was reached.',
    );
  });

  it('opens and closes a declared phase the run never reached', async () => {
    const { trace, events } = recordingTrace();
    await runPersistedWorkflowScriptWithProgress(trace, {
      store: getExecutionStore(executionId),
      checkpointId: 'unreached-phase',
      script: `export const meta = {
  name: 'unreached-phase',
  description: 'declares a phase the run never enters',
  phases: [{ title: 'Research' }, { title: 'Write' }],
  tasks: [
    { id: 'used', label: 'Used task', phase: 'Research' },
    { id: 'later', label: 'Later task', phase: 'Write' },
  ],
}
phase('Research')
return await agent('Run one', { id: 'used' })`,
      runAgent: async () => 'done',
    });

    // The skipped card still belongs to its own phase group, so the sweep has
    // to open that stage even though the script never entered it.
    const writeId = stageId(events, 'Write');
    expect(workflowCallEvent(events, 'Later task', 'skipped')).toMatchObject({
      stageId: writeId,
      task: { reason: 'not-reached' },
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'stage.start',
        id: writeId,
        kind: 'phase',
      }),
    );
    expect(events).toContainEqual({
      type: 'stage.end',
      id: writeId,
      status: RUN_OUTCOME.COMPLETED,
    });
  });

  it('keeps a phase-less declared task out of the phase active at call time', async () => {
    const { trace, events } = recordingTrace();
    await runPersistedWorkflowScriptWithProgress(trace, {
      store: getExecutionStore(executionId),
      checkpointId: 'phase-less-declared-task',
      script: `export const meta = {
  name: 'phase-less-declared-task',
  description: 'declares a task with no phase',
  phases: [{ title: 'Research' }],
  tasks: [{ id: 'loose', label: 'Loose task' }],
}
phase('Research')
return await agent('Run loose', { id: 'loose' })`,
      runAgent: async () => 'done',
    });

    // meta.tasks[].phase is optional, so the plan can declare a task with no
    // phase while a phase() is active. Its card must stay where it was first
    // classified — a progress tree cannot move a card between groups — and the
    // payload every host folds `done/total` by must say the same thing, so a
    // phase-less task is counted under no phase rather than under the wrong one.
    for (const status of ['planned', 'running', 'completed'] as const) {
      expect(workflowCallEvent(events, 'Loose task', status)).toMatchObject({
        stageId: undefined,
      });
      expect(
        workflowCallEvent(events, 'Loose task', status)?.task.phase,
      ).toBeUndefined();
    }

    // The two answers agree by construction: the phase whose group holds the
    // card and the phase the shared fold reads off the payload are the same
    // recorded value. Under the active phase both are empty.
    const researchId = stageId(events, 'Research');
    const latest = latestWorkflowCallEvents(events);
    expect(
      workflowPhaseCallProgress(
        latest.flatMap((event) =>
          event.task.phase === 'Research' ? [event.task] : [],
        ),
      ),
    ).toEqual({ done: 0, total: 0 });
    expect(latest.filter((event) => event.stageId === researchId)).toHaveLength(
      0,
    );
  });

  it('does not fail an active phase for a failed phase-less declared task', async () => {
    const { trace, events } = recordingTrace();
    await runPersistedWorkflowScriptWithProgress(trace, {
      store: getExecutionStore(executionId),
      checkpointId: 'failed-phase-less-declared-task',
      script: `export const meta = {
  name: 'failed-phase-less-declared-task',
  description: 'keeps a phase-less failure outside the active phase',
  phases: [{ title: 'Research' }],
  tasks: [{ id: 'loose', label: 'Loose task' }],
}
phase('Research')
return await agent('Run loose', { id: 'loose' })`,
      runAgent: async () => {
        throw new Error('model unavailable');
      },
    });

    const researchId = stageId(events, 'Research');
    expect(workflowCallEvent(events, 'Loose task', 'failed')).toMatchObject({
      stageId: undefined,
      task: { phase: undefined, error: 'model unavailable' },
    });
    expect(events).toContainEqual({
      type: 'stage.end',
      id: researchId,
      status: RUN_OUTCOME.COMPLETED,
    });
  });

  it('marks a planned task failed when the live-call cap refuses it', async () => {
    const { trace, events } = recordingTrace();
    await expect(
      runPersistedWorkflowScriptWithProgress(trace, {
        store: getExecutionStore(executionId),
        checkpointId: 'planned-call-cap',
        script: `export const meta = {
  name: 'planned-call-cap',
  description: 'distinguishes refused work from work not reached',
  phases: [{ title: 'Audit' }],
  tasks: [
    { id: 'first', label: 'First audit', phase: 'Audit' },
    { id: 'refused', label: 'Refused audit', phase: 'Audit' },
  ],
}
await agent('Run first', { id: 'first' })
return await agent('Run refused', { id: 'refused' })`,
        maxAgentCalls: 1,
        runAgent: async () => 'done',
      }),
    ).rejects.toThrow(/agent-call cap/);

    expect(workflowCallEvent(events, 'Refused audit', 'failed')).toMatchObject({
      task: {
        error: expect.stringContaining('agent-call cap'),
      },
    });
    expect(
      workflowCallEvent(events, 'Refused audit', 'skipped'),
    ).toBeUndefined();
  });

  it.each([
    [
      'sequential',
      `await agent('First prompt', {
  id: 'shared-journal-id',
  label: 'First task',
  phase: 'Review',
})
return await agent('Second prompt', {
  id: 'shared-journal-id',
  label: 'Second task',
  phase: 'Write',
})`,
    ],
    [
      'parallel',
      `return await parallel([
  () => agent('First prompt', {
    id: 'shared-journal-id',
    label: 'First task',
    phase: 'Review',
  }),
  () => agent('Second prompt', {
    id: 'shared-journal-id',
    label: 'Second task',
    phase: 'Write',
  }),
])`,
    ],
  ] as const)(
    'keeps %s calls with one journal id as separate progress records',
    async (mode, body) => {
      const { trace, events } = recordingTrace();
      await runPersistedWorkflowScriptWithProgress(trace, {
        store: getExecutionStore(executionId),
        checkpointId: `reused-journal-id-${mode}`,
        script: `${meta}
${body}`,
        runAgent: async () => 'done',
      });

      const firstRunning = workflowCallEvent(events, 'First task', 'running');
      const firstCompleted = workflowCallEvent(
        events,
        'First task',
        'completed',
      );
      const secondRunning = workflowCallEvent(events, 'Second task', 'running');
      const secondCompleted = workflowCallEvent(
        events,
        'Second task',
        'completed',
      );

      expect(firstRunning?.task.id).toBe('call-0');
      expect(firstCompleted?.logId).toBe(firstRunning?.logId);
      expect(secondRunning?.task.id).toBe('call-1');
      expect(secondCompleted?.logId).toBe(secondRunning?.logId);
      expect(firstRunning?.logId).not.toBe(secondRunning?.logId);
    },
  );

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
    expect(workflowCallEvent(events, 'Read', 'cached')).toMatchObject({
      type: 'workflow.task',
      stageId: phaseId,
    });
    expect(workflowCallEvent(events, 'Read', 'running')).toBeUndefined();
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

  it('projects trimmed runtime and declared task phases onto one stage', async () => {
    const { trace, events } = recordingTrace();
    const script = `export const meta = {
  name: 'trimmed-declared-task-phase',
  description: 'keeps task and runtime phase identity canonical',
  phases: [{ title: '  Review  ' }],
  tasks: [{
    id: 'review-task',
    label: '  Review argument  ',
    phase: '  Review  ',
  }],
}
phase('  Review  ')
return await agent('Review the argument', { id: 'review-task' })`;

    await runPersistedWorkflowScriptWithProgress(trace, {
      store: getExecutionStore(executionId),
      checkpointId: 'trimmed-declared-task-phase',
      script,
      runAgent: async () => 'done',
    });

    const phaseStarts = events.filter(
      (event) => event.type === 'stage.start' && event.kind === 'phase',
    );
    expect(phaseStarts).toEqual([
      expect.objectContaining({
        label: 'Review',
        index: 0,
        total: 1,
      }),
    ]);
    const planned = workflowCallEvent(events, 'Review argument', 'planned');
    for (const status of ['planned', 'running', 'completed'] as const) {
      expect(
        workflowCallEvent(events, 'Review argument', status),
      ).toMatchObject({
        logId: planned?.logId,
        task: {
          id: 'review-task',
          label: 'Review argument',
          phase: 'Review',
          status,
        },
      });
    }
  });

  it('renders each call cost on live finish lines only', async () => {
    const store = getExecutionStore(executionId);
    const script = `${meta}
await agent('First')
return await agent('Second')`;
    const { trace, events } = recordingTrace();
    const callCosts = new Map<number, number>();
    await runPersistedWorkflowScriptWithProgress(trace, {
      store,
      checkpointId: 'live-cost',
      script,
      runAgent: async (invocation) => {
        callCosts.set(invocation.index, 0.05);
        return 'done';
      },
      getCallCostUsd: (index) => callCosts.get(index),
    });

    expect(workflowCallEvent(events, 'First', 'completed')?.task).toMatchObject(
      {
        totalCostUsd: 0.05,
      },
    );
    expect(
      workflowCallEvent(events, 'Second', 'completed')?.task,
    ).toMatchObject({
      totalCostUsd: 0.05,
    });

    clearStoreCache();
    const replay = recordingTrace();
    await runPersistedWorkflowScriptWithProgress(replay.trace, {
      store: getExecutionStore(executionId),
      checkpointId: 'live-cost',
      script,
      runAgent: vi.fn(() => Promise.reject(new Error('must not run'))),
      getCallCostUsd: () => 0,
    });

    expect(
      workflowCallEvent(replay.events, 'First', 'cached')?.task,
    ).not.toHaveProperty('totalCostUsd');
  });

  it('enriches live finish lines with the reported model and duration', async () => {
    const { trace, events } = recordingTrace();
    const activities: string[] = [];
    await runPersistedWorkflowScriptWithProgress(trace, {
      store: getExecutionStore(executionId),
      checkpointId: 'model-duration',
      script: `${meta}
return await agent('Draft')`,
      runAgent: async (invocation: WorkflowAgentInvocation) => {
        invocation.reportModel?.('deepseekT');
        invocation.reportChildStream?.('draft@deepseekT#abcdef' as StreamTabId);
        return 'done';
      },
      getCallCostUsd: () => 0.02,
      onActivity: (line) => activities.push(line),
    });

    expect(workflowCallEvent(events, 'Draft', 'completed')?.task).toMatchObject(
      {
        model: 'deepseekT',
        childStreamId: 'draft@deepseekT#abcdef',
        durationMs: expect.any(Number),
        totalCostUsd: 0.02,
      },
    );
    const draftEvents = events.filter(
      (event): event is Extract<AgentEvent, { type: 'workflow.task' }> =>
        event.type === 'workflow.task' && event.task.label === 'Draft',
    );
    const logIds = new Set(draftEvents.map((event) => event.logId));
    expect(logIds.size).toBe(1);
    expect([...logIds][0]).toMatch(/^workflow-task-.+-call-0$/);
    expect(activities).toContainEqual(
      expect.stringMatching(/^Finished: Draft · deepseekT · .+ · \$0\.020$/),
    );
  });

  it('uses a new task-card identity for a deterministic relaunch', async () => {
    const script = `${meta}
return await agent('Draft')`;
    const first = recordingTrace();
    await runPersistedWorkflowScriptWithProgress(first.trace, {
      store: getExecutionStore(executionId),
      checkpointId: 'relaunch-card-id',
      script,
      runAgent: vi.fn(() => Promise.resolve('done')),
    });

    clearStoreCache();
    const second = recordingTrace();
    await runPersistedWorkflowScriptWithProgress(second.trace, {
      store: getExecutionStore(executionId),
      checkpointId: 'relaunch-card-id',
      script,
      runAgent: vi.fn(() => Promise.reject(new Error('must not run'))),
    });

    const firstId = workflowCallEvent(
      first.events,
      'Draft',
      'completed',
    )?.logId;
    const secondId = workflowCallEvent(second.events, 'Draft', 'cached')?.logId;
    expect(firstId).toBeDefined();
    expect(secondId).toBeDefined();
    expect(secondId).not.toBe(firstId);
  });

  it('preserves live metadata when the user skips a running call', async () => {
    const { trace, events } = recordingTrace();
    const activities: string[] = [];
    let control!: WorkflowScriptControl;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const run = runPersistedWorkflowScriptWithProgress(trace, {
      store: getExecutionStore(executionId),
      checkpointId: 'late-user-skip',
      script: `${meta}
return await agent('Late skip')`,
      runAgent: async (invocation: WorkflowAgentInvocation) => {
        invocation.reportModel?.('kimiK2');
        markStarted?.();
        return await new Promise<never>((_resolve, reject) => {
          invocation.signal.addEventListener(
            'abort',
            () => reject(new Error('skipped')),
            { once: true },
          );
        });
      },
      onControl: (handle) => {
        control = handle;
      },
      getCallCostUsd: () => 0.04,
      onActivity: (line) => activities.push(line),
    });

    await started;
    control.skip(0);
    await run;

    expect(
      workflowCallEvent(events, 'Late skip', 'skipped')?.task,
    ).toMatchObject({
      reason: 'user',
      model: 'kimiK2',
      durationMs: expect.any(Number),
      totalCostUsd: 0.04,
    });
    expect(activities).toContain('Running: Late skip');
    expect(activities).toContainEqual(
      expect.stringMatching(/^Skipped: Late skip · kimiK2 · .+ · \$0\.040$/),
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
    expect(workflowCallEvent(events, 'Unsuccessful', 'failed')).toMatchObject({
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
    expect(workflowCallEvent(events, 'slow', 'completed')).toMatchObject({
      stageId: firstId,
    });
    expect(workflowCallEvent(events, 'fast', 'completed')).toMatchObject({
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

    const completion = workflowCallEvent(events, 'before phase', 'completed');
    expect(completion).toMatchObject({
      type: 'workflow.task',
      stageId: undefined,
    });
    expect(completion).not.toMatchObject({ stageId: stageId(events, 'Later') });
  });

  it('preserves the exact cause when a runner aborts a started phase', async () => {
    const { trace, events } = recordingTrace();
    const activities: string[] = [];
    await expect(
      runPersistedWorkflowScriptWithProgress(trace, {
        store: getExecutionStore(executionId),
        checkpointId: 'runner-abort',
        script: `${meta}
return await agent('Abort', { phase: 'Execution' })`,
        runAgent: async (invocation: WorkflowAgentInvocation) => {
          invocation.reportModel?.('abort-model');
          throw new WorkflowRunAbortError('fatal runner error');
        },
        getCallCostUsd: () => 0.06,
        onActivity: (line) => activities.push(line),
      }),
    ).rejects.toThrow('fatal runner error');

    const phaseId = stageId(events, 'Execution');
    expect(workflowCallEvent(events, 'Abort', 'failed')).toMatchObject({
      stageId: phaseId,
      task: {
        error: 'fatal runner error',
        model: 'abort-model',
        durationMs: expect.any(Number),
        totalCostUsd: 0.06,
      },
    });
    expect(events).toContainEqual({
      type: 'stage.end',
      id: phaseId,
      status: RUN_OUTCOME.FAILED,
    });
    expect(activities).toContainEqual(
      expect.stringMatching(
        /^Failed: Abort · abort-model · .+ · \$0\.060 — fatal runner error$/,
      ),
    );
  });

  it('marks a phase failed when an abandoned call outlives cleanup', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { trace, events } = recordingTrace();
      const activities: string[] = [];
      const getCallCostUsd = vi.fn((index: number) =>
        index === 0 ? 0.03 : undefined,
      );
      let markStarted: (() => void) | undefined;
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      const run = runPersistedWorkflowScriptWithProgress(trace, {
        store: getExecutionStore(executionId),
        checkpointId: 'orphaned-runner',
        script: `${meta}
agent('Orphaned', { phase: 'Execution' })
return 'guest success'`,
        runAgent: async (invocation: WorkflowAgentInvocation) => {
          invocation.reportChildStream?.(
            'orphaned@model#abcdef' as StreamTabId,
          );
          markStarted?.();
          return await new Promise<never>(() => undefined);
        },
        getCallCostUsd,
        onActivity: (line) => activities.push(line),
      });

      await started;
      await vi.advanceTimersByTimeAsync(5_000);
      await run;

      const phaseId = stageId(events, 'Execution');
      expect(workflowCallEvent(events, 'Orphaned', 'failed')).toMatchObject({
        stageId: phaseId,
        task: {
          error: 'The workflow ended before this call completed.',
          totalCostUsd: 0.03,
          childStreamId: 'orphaned@model#abcdef',
        },
      });
      expect(events).toContainEqual({
        type: 'stage.end',
        id: phaseId,
        status: RUN_OUTCOME.FAILED,
      });
      expect(getCallCostUsd).toHaveBeenCalledWith(0);
      expect(activities).toContain('Running: Orphaned');
      expect(activities).toContain(
        'Failed: Orphaned · $0.030 — The workflow ended before this call completed.',
      );
    } finally {
      vi.useRealTimers();
    }
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
