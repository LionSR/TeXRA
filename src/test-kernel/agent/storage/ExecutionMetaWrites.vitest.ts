import { describe, expect, it, vi } from 'vitest';

import { finalizeExecution, getExecutionStore } from '@agent/storage';
import { writeSessionDescription } from '@agent/storage/executionLifecycle';
import { RUN_OUTCOME, type ExecutionId } from '@shared/schemas';
import { setupPlatform } from '@test/support/setupPlatform';

describe('execution metadata updates', () => {
  setupPlatform({ workspacePath: '/workspace' });

  it('keeps every field when updates for one execution overlap', async () => {
    const id = 'bbb001' as ExecutionId;
    await getExecutionStore(id).writeMeta({
      timestamp: new Date(0).toISOString(),
    });

    // Both are read-modify-write cycles over the same metadata record; without
    // per-execution serialization the later write drops the earlier field.
    await Promise.all([
      writeSessionDescription(id, 'A described session'),
      finalizeExecution({
        executionId: id,
        outcome: RUN_OUTCOME.COMPLETED,
        flowRecord: 'preserve',
      }),
    ]);

    const meta = await getExecutionStore(id).readMeta();
    expect(meta?.description).toBe('A described session');
    expect(meta?.outcome).toBe(RUN_OUTCOME.COMPLETED);
  });

  // The host-exit drain finalizes CANCELLED for whatever a session still owns,
  // and can reach the meta lock just after the run's own driver recorded a real
  // outcome. Serialization alone would let it overwrite that; the backstop must
  // yield to the driver instead.
  it('keeps a driver-written outcome when a backstop finalizer follows it', async () => {
    const id = 'bbb002' as ExecutionId;
    await getExecutionStore(id).writeMeta({
      timestamp: new Date(0).toISOString(),
    });

    await finalizeExecution({
      executionId: id,
      outcome: RUN_OUTCOME.COMPLETED,
      flowRecord: 'preserve',
    });
    await finalizeExecution({
      executionId: id,
      outcome: RUN_OUTCOME.CANCELLED,
      flowRecord: 'preserve',
      keepExistingOutcome: true,
    });

    expect((await getExecutionStore(id).readMeta())?.outcome).toBe(
      RUN_OUTCOME.COMPLETED,
    );
  });

  it('updates and finalizes core metadata despite malformed workflow observability', async () => {
    const id = 'bbb003' as ExecutionId;
    const store = getExecutionStore(id);
    await store.write('meta', {
      timestamp: new Date(0).toISOString(),
      identity: { kind: 'process', tool: 'bash' },
      description: 'Original description',
      workflow: { lifecycle: 'active' },
    });

    await writeSessionDescription(id, 'Updated description');
    await expect(
      finalizeExecution({
        executionId: id,
        outcome: RUN_OUTCOME.COMPLETED,
        flowRecord: 'preserve',
      }),
    ).resolves.toMatchObject({ status: 'durable' });

    const meta = await store.readMeta();
    expect(meta).toMatchObject({
      identity: { kind: 'process', tool: 'bash' },
      description: 'Updated description',
      outcome: RUN_OUTCOME.COMPLETED,
    });
    expect(meta?.workflow).toBeUndefined();
  });

  it('resolves to a failed result instead of rejecting when the terminal write fails', async () => {
    const id = 'bbb004' as ExecutionId;
    const store = getExecutionStore(id);
    await store.writeMeta({
      timestamp: new Date(0).toISOString(),
    });

    // Catchless callers (terminalPersistence, runAgent, CLI finalization)
    // rely on finalizeExecution never rejecting: every store failure must
    // surface as a 'failed' result (#10614). CANCELLED + 'preserve' skips
    // the fail-closed flow-record delete, isolating the terminal-write arm.
    const writeError = new Error('terminal write rejected');
    const writeSpy = vi
      .spyOn(store, 'writeMeta')
      .mockRejectedValueOnce(writeError);
    try {
      await expect(
        finalizeExecution({
          executionId: id,
          outcome: RUN_OUTCOME.CANCELLED,
          flowRecord: 'preserve',
        }),
      ).resolves.toEqual({
        status: 'failed',
        error: writeError,
        stage: 'terminal-status',
        outcomePersisted: false,
      });
    } finally {
      writeSpy.mockRestore();
    }
  });

  it('accepts a later update after one fails on absent metadata', async () => {
    const id = 'bbb002' as ExecutionId;
    // Nothing to read-modify-write yet: this update fails inside the lock and
    // must release it, or every later update for the execution would hang.
    const failing = writeSessionDescription(id, 'dropped');
    await getExecutionStore(id).writeMeta({
      timestamp: new Date(0).toISOString(),
    });
    await failing;

    await writeSessionDescription(id, 'Written after the failure');

    expect((await getExecutionStore(id).readMeta())?.description).toBe(
      'Written after the failure',
    );
  });
});
