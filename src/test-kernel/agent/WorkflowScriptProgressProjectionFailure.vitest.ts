import { describe, expect, it, vi } from 'vitest';

import type { AgentTrace } from '@agent/trace';
import type { PersistedWorkflowScriptRunOptions } from '@agent/workflowScript';
import type { WorkflowExecutionSnapshot } from '@shared/schemas';
import { runPersistedWorkflowScriptWithProgress } from '@tools/delegation/workflowScriptRun';

const mocks = vi.hoisted(() => ({
  runPersistedWorkflowScript: vi.fn(),
}));

vi.mock('@agent/workflowScript', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/workflowScript')>()),
  runPersistedWorkflowScript: mocks.runPersistedWorkflowScript,
}));

function snapshot(
  lifecycle: 'waiting' | 'active',
  status: 'planned' | 'starting',
): WorkflowExecutionSnapshot {
  return {
    stages: [
      {
        id: 'stage-review',
        title: 'Review',
        order: 0,
        lifecycle,
      },
    ],
    calls: [
      {
        id: 'retry-review',
        label: 'Retry review',
        stageId: 'stage-review',
        stageTitle: 'Review',
        status,
        attempts: [{}],
        files: {},
        timestamps: {
          createdAt: '2026-08-15T20:00:00.000Z',
          updatedAt: '2026-08-15T20:00:01.000Z',
        },
      },
    ],
  } as WorkflowExecutionSnapshot;
}

describe('workflow-script projection failure recovery', () => {
  it('retains call-issued admission when that fold fails before projection', async () => {
    const construction = snapshot('waiting', 'planned');
    const issued = snapshot('active', 'planned');
    const running = snapshot('active', 'starting');
    mocks.runPersistedWorkflowScript.mockImplementationOnce(
      async (options: PersistedWorkflowScriptRunOptions) => {
        options.onTransition?.(construction);
        options.onTransition?.(issued, {
          type: 'call-issued',
          callId: 'retry-review',
        });
        options.onTransition?.(running);
        await options.onSnapshot?.(running);
        return { snapshot: running } as never;
      },
    );

    const emit = vi.fn();
    const warn = vi.fn();
    const openStage = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('trace projection unavailable');
      })
      .mockReturnValue({ id: 'trace-review', end: vi.fn() });
    const trace = {
      activeStageId: vi.fn(),
      emit,
      info: vi.fn(),
      warn,
      openStage,
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
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'workflow.call',
        call: expect.objectContaining({
          id: 'retry-review',
          status: 'running',
        }),
      }),
    );
  });
});
