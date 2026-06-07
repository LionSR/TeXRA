import { beforeEach, describe, expect, it } from 'vitest';

import {
  IdleContinuationRegistry,
  type IdleContinuationContext,
  type IdleContinuationProvider,
} from '@agent/runtime/idleContinuation';
import type { StreamTabId } from '@shared/schemas';

const STREAM_ID = 'stream:idle-cont' as StreamTabId;

function emptyContext(): IdleContinuationContext {
  return { streamId: STREAM_ID, isSubagent: false, hasQueuedFollowUp: false };
}

describe('idle-continuation registry', () => {
  let registry: IdleContinuationRegistry;

  beforeEach(() => {
    registry = new IdleContinuationRegistry();
  });

  it('registers providers and returns them in insertion order', () => {
    registry.register({
      source: 'first',
      build: async () => null,
    });
    registry.register({
      source: 'second',
      build: async () => null,
    });

    const sources = registry.list().map((p) => p.source);
    expect(sources).toEqual(['first', 'second']);
  });

  it('rejects duplicate `source` registrations', () => {
    registry.register({ source: 'dup', build: async () => null });
    expect(() =>
      registry.register({ source: 'dup', build: async () => null }),
    ).toThrow(/Duplicate idle-continuation provider/);
  });

  it('lets a provider synthesize a continuation that the wait-node can commit', async () => {
    let committed = false;
    registry.register({
      source: 'test',
      build: async () => ({
        source: 'test',
        followUp: 'keep going',
        commit: async () => {
          committed = true;
        },
      }),
    });

    const [provider] = registry.list();
    const result = await provider.build(emptyContext());
    expect(result?.followUp).toBe('keep going');
    await result?.commit();
    expect(committed).toBe(true);
  });

  it('keeps providers scoped to each registry instance', () => {
    const other = new IdleContinuationRegistry();
    const provider: IdleContinuationProvider = {
      source: 'test',
      build: async () => null,
    };

    registry.register(provider);

    expect(registry.list()).toEqual([provider]);
    expect(other.list()).toEqual([]);
  });
});
