import '@test/support/defaultSessionTestSetup';
import { describe, expect, it, vi } from 'vitest';

import { currentSession } from '@agent/runtime/SessionHandle';
import type { AgentTrace } from '@agent/trace';
import { WorkflowRunSnapshotSchema, type RunId } from '@shared/schemas';
import { projectWorkflowScriptProgress } from '@tools/delegation/workflowScriptRun';

/** Named on the options; these cases drive the projection directly and never
 *  persist a script row, so the run itself is never read. */
const parentRunId = '7154decade02' as RunId;

function snapshot(status: 'declared' | 'running') {
  const timestamp = '2026-08-15T20:00:00.000Z';
  const active = status === 'running';
  return WorkflowRunSnapshotSchema.parse({
    lifecycle: active ? 'active' : 'waiting',
    stages: [],
    calls: [
      {
        id: 'retry-review',
        label: 'Retry review',
        status,
        ...(active && { kind: 'document', agent: 'historical-agent' }),
        attempts: [],
        files: { input: [], context: [], media: [] },
        timestamps: { createdAt: timestamp, updatedAt: timestamp },
      },
    ],
    timestamps: { createdAt: timestamp, updatedAt: timestamp },
  });
}

describe('workflow-script projection failure recovery', () => {
  it('projects an issued call after a fold fails before projection', async () => {
    const construction = snapshot('declared');
    const running = snapshot('running');
    const emit = vi.fn().mockImplementationOnce(() => {
      throw new Error('trace projection unavailable');
    });
    const warn = vi.fn();
    const trace = {
      activeStageId: vi.fn(),
      emit,
      info: vi.fn(),
      warn,
      openStage: vi.fn(),
    } as unknown as AgentTrace;

    const projection = projectWorkflowScriptProgress(trace, {
      session: currentSession(),
      parentRunId,
      checkpointId: 'projection-failure',
      script: 'return await agent("Retry review")',
      runAgent: vi.fn(),
    });
    // The engine's transitions and its terminal snapshot, driven directly:
    // the subject is the projection's own recovery, not a script run.
    projection.options.onTransition?.(construction);
    projection.options.onTransition?.(running);
    await projection.options.onSnapshot?.(running);
    projection.settle(true);

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('trace projection unavailable'),
      expect.anything(),
    );
    const projected = emit.mock.calls
      .map(([event]) => event)
      .find((event) => event.call?.status === 'running');
    expect(projected?.call).toStrictEqual({
      id: 'retry-review',
      label: 'Retry review',
      status: 'running',
      kind: 'document',
      agent: 'historical-agent',
      files: { input: [], context: [], media: [] },
      attemptId: expect.any(String),
    });
  });

  it("retains a retried call's attempt number when the backstop terminalizes it", async () => {
    const construction = snapshot('declared');
    const running = snapshot('running');
    for (const state of [construction, running]) {
      const call = state.calls[0];
      if (call) {
        call.attempts = [
          {
            number: 1,
            startedAt: '2026-08-15T20:00:00.000Z',
          },
          {
            number: 2,
            startedAt: '2026-08-15T20:00:01.000Z',
          },
        ];
      }
    }
    const emit = vi.fn();
    const trace = {
      activeStageId: vi.fn(),
      emit,
      info: vi.fn(),
      warn: vi.fn(),
      openStage: vi.fn().mockReturnValue({
        id: 'trace-review',
        end: vi.fn(),
      }),
    } as unknown as AgentTrace;

    const projection = projectWorkflowScriptProgress(trace, {
      session: currentSession(),
      parentRunId,
      checkpointId: 'attempt-number-backstop',
      script: 'return await agent("Retry review")',
      runAgent: vi.fn(),
    });
    // The engine's transitions and its terminal snapshot, driven directly:
    // the subject is the projection's own recovery, not a script run.
    projection.options.onTransition?.(construction);
    projection.options.onTransition?.(running);
    await projection.options.onSnapshot?.(running);
    projection.settle(true);

    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'workflow.call',
        call: expect.objectContaining({
          status: 'running',
          attemptNumber: 2,
        }),
      }),
    );
    expect(emit).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: 'workflow.call',
        call: expect.objectContaining({
          status: 'failed',
          attemptNumber: 2,
        }),
      }),
    );
  });
});
