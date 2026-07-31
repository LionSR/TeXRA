import { describe, expect, it } from 'vitest';

import { getExecutionStore } from '@agent/storage';
import { hasPersistedParent } from '@agent/storage/executionLifecycle';
import type { ExecutionId } from '@shared/schemas';
import { setupPlatform } from '@test/support/setupPlatform';

async function writeParentLink(
  executionId: ExecutionId,
  parentExecutionId?: ExecutionId,
): Promise<void> {
  await getExecutionStore(executionId).writeMeta({
    timestamp: new Date(0).toISOString(),
    ...(parentExecutionId ? { parentExecutionId } : {}),
  });
}

describe('hasPersistedParent', () => {
  setupPlatform({ workspacePath: '/workspace' });

  it('returns false for an execution without a parent', async () => {
    const id = 'aaa001' as ExecutionId;
    await writeParentLink(id);

    expect(await hasPersistedParent(id)).toBe(false);
  });

  it('returns false when its own metadata is unavailable', async () => {
    const id = 'aaa002' as ExecutionId;

    expect(await hasPersistedParent(id)).toBe(false);
  });

  it('returns true from the direct parent link without reading the parent', async () => {
    const child = 'aaa010' as ExecutionId;
    await writeParentLink(child, 'aaa0ff' as ExecutionId);

    expect(await hasPersistedParent(child)).toBe(true);
  });
});
