import { describe, expect, it } from 'vitest';

import { finalizeExecution, getExecutionStore } from '@agent/storage';
import { writeSessionDescription } from '@agent/storage/executionLifecycle';
import { EXECUTION_STATUS, type ExecutionId } from '@shared/schemas';
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
        terminalStatus: EXECUTION_STATUS.COMPLETED,
        flowRecord: 'preserve',
      }),
    ]);

    const meta = await getExecutionStore(id).readMeta();
    expect(meta?.description).toBe('A described session');
    expect(meta?.terminalStatus).toBe(EXECUTION_STATUS.COMPLETED);
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
