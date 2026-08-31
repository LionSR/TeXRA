import { describe, expect, it, vi } from 'vitest';

import type { AgentTrace } from '@agent/trace';
import type { PersistedWorkflowScriptRunOptions } from '@agent/workflowScript';
import { PersistedWorkflowExecutionSnapshotSchema } from '@shared/schemas';
import { runPersistedWorkflowScriptWithProgress } from '@tools/delegation/workflowScriptRun';

const mocks = vi.hoisted(() => ({
  runPersistedWorkflowScript: vi.fn(),
}));

vi.mock('@agent/workflowScript', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/workflowScript')>()),
  runPersistedWorkflowScript: mocks.runPersistedWorkflowScript,
}));

function snapshot(status: 'planned' | 'running', markerFree = false) {
  const timestamp = '2026-08-15T20:00:00.000Z';
  const active = status === 'running';
  return PersistedWorkflowExecutionSnapshotSchema.parse({
    lifecycle: active ? 'active' : 'waiting',
    stages: [],
    calls: [
      {
        id: 'retry-review',
        label: 'Retry review',
        status,
        ...(active &&
          (markerFree
            ? { agent: 'historical-agent' }
            : { issued: true, kind: 'document' })),
        attempts: [],
        files: { input: [], context: [], media: [] },
        timestamps: { createdAt: timestamp, updatedAt: timestamp },
      },
    ],
    timestamps: { createdAt: timestamp, updatedAt: timestamp },
  });
}

describe('workflow-script projection failure recovery', () => {
  it('projects a marker-free issued call after a fold fails before projection', async () => {
    const construction = snapshot('planned');
    const running = snapshot('running', true);
    mocks.runPersistedWorkflowScript.mockImplementationOnce(
      async (options: PersistedWorkflowScriptRunOptions) => {
        options.onTransition?.(construction);
        options.onTransition?.(running);
        await options.onSnapshot?.(running);
        return { snapshot: running } as never;
      },
    );

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

    await runPersistedWorkflowScriptWithProgress(trace, {
      store: {} as never,
      checkpointId: 'projection-failure',
      script: 'return await agent("Retry review")',
      runAgent: vi.fn(),
    });

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
      agent: 'historical-agent',
      files: { input: [], context: [], media: [] },
      attemptId: expect.any(String),
    });
  });

  it("retains a retried call's attempt number when the backstop terminalizes it", async () => {
    const construction = snapshot('planned');
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
    mocks.runPersistedWorkflowScript.mockImplementationOnce(
      async (options: PersistedWorkflowScriptRunOptions) => {
        options.onTransition?.(construction);
        options.onTransition?.(running);
        await options.onSnapshot?.(running);
        return { snapshot: running } as never;
      },
    );

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

    await runPersistedWorkflowScriptWithProgress(trace, {
      store: {} as never,
      checkpointId: 'attempt-number-backstop',
      script: 'return await agent("Retry review")',
      runAgent: vi.fn(),
    });

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
