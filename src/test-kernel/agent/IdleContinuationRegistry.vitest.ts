import { beforeEach, describe, expect, it } from 'vitest';

import {
  __resetIdleContinuationRegistry,
  listIdleContinuationProviders,
  registerIdleContinuation,
  type IdleContinuationContext,
} from '@agent/runtime/idleContinuation';
import type { StreamTabId } from '@shared/schemas';

const STREAM_ID = 'stream:idle-cont' as StreamTabId;

function emptyContext(): IdleContinuationContext {
  return { streamId: STREAM_ID, isSubagent: false, hasQueuedFollowUp: false };
}

describe('idle-continuation registry', () => {
  beforeEach(() => {
    __resetIdleContinuationRegistry();
  });

  it('registers providers and returns them in insertion order', () => {
    registerIdleContinuation({
      source: 'first',
      build: async () => null,
    });
    registerIdleContinuation({
      source: 'second',
      build: async () => null,
    });

    const sources = listIdleContinuationProviders().map((p) => p.source);
    expect(sources).toEqual(['first', 'second']);
  });

  it('rejects duplicate `source` registrations', () => {
    registerIdleContinuation({ source: 'dup', build: async () => null });
    expect(() =>
      registerIdleContinuation({ source: 'dup', build: async () => null }),
    ).toThrow(/Duplicate idle-continuation provider/);
  });

  it('lets a provider synthesize a continuation that the wait-node can commit', async () => {
    let committed = false;
    registerIdleContinuation({
      source: 'test',
      build: async () => ({
        source: 'test',
        followUp: 'keep going',
        commit: async () => {
          committed = true;
        },
      }),
    });

    const [provider] = listIdleContinuationProviders();
    const result = await provider.build(emptyContext());
    expect(result?.followUp).toBe('keep going');
    await result?.commit();
    expect(committed).toBe(true);
  });
});
