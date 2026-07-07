import { describe, expect, it } from 'vitest';

import { setupPlatform } from '@test/support/setupPlatform';
import { getExecutionStore } from '@agent/storage';
import { computeDelegationDepthFromStorage } from '@agent/runtime/delegationPolicy';
import type { ExecutionId } from '@shared/schemas';

async function writeParentLink(
  executionId: ExecutionId,
  parentExecutionId?: ExecutionId,
): Promise<void> {
  await getExecutionStore(executionId).writeMeta({
    timestamp: new Date(0).toISOString(),
    ...(parentExecutionId ? { parentExecutionId } : {}),
  });
}

describe('computeDelegationDepthFromStorage', () => {
  setupPlatform({ workspacePath: '/workspace' });

  it('returns 0 for a confirmed root (no parentExecutionId)', async () => {
    const id = 'aaa001' as ExecutionId;
    await writeParentLink(id);

    expect(await computeDelegationDepthFromStorage(id)).toBe(0);
  });

  it('returns 0 when its own meta is unreadable (no evidence either way)', async () => {
    const id = 'aaa002' as ExecutionId;

    expect(await computeDelegationDepthFromStorage(id)).toBe(0);
  });

  it('walks a legacy parent chain lacking delegationDepth to the correct depth', async () => {
    const grandparent = 'aaa010' as ExecutionId;
    const parent = 'aaa011' as ExecutionId;
    const child = 'aaa012' as ExecutionId;
    await writeParentLink(grandparent);
    await writeParentLink(parent, grandparent);
    await writeParentLink(child, parent);

    expect(await computeDelegationDepthFromStorage(child)).toBe(2);
  });

  it('reports the confirmed lower-bound depth instead of 0 when an ancestor is unreadable', async () => {
    // child -> parent -> (missing grandparent). `parentExecutionId` on the
    // child's own meta already proves it isn't a root, so the fallback must
    // not silently promote it to depth 0 once the walk hits the broken link.
    const parent = 'aaa020' as ExecutionId;
    const child = 'aaa021' as ExecutionId;
    await writeParentLink(parent, 'aaa0ff' as ExecutionId);
    await writeParentLink(child, parent);

    expect(await computeDelegationDepthFromStorage(child)).toBe(2);
  });

  it('reports the confirmed lower-bound depth instead of 0 on a cyclic chain', async () => {
    const a = 'aaa030' as ExecutionId;
    const b = 'aaa031' as ExecutionId;
    const child = 'aaa032' as ExecutionId;
    // a -> b -> a (cycle), reached via child -> a.
    await writeParentLink(a, b);
    await writeParentLink(b, a);
    await writeParentLink(child, a);

    expect(await computeDelegationDepthFromStorage(child)).toBeGreaterThan(0);
  });

  it('prefers the persisted delegationDepth field over walking the chain', async () => {
    const id = 'aaa040' as ExecutionId;
    await getExecutionStore(id).writeMeta({
      timestamp: new Date(0).toISOString(),
      parentExecutionId: 'aaa041' as ExecutionId,
      delegationDepth: 7,
    });

    expect(await computeDelegationDepthFromStorage(id)).toBe(7);
  });
});
