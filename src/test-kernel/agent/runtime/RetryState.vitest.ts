// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - agent runtime
import { RetryableInvocationNode } from '@agent/core/flows/RetryState';
import type { NonIterableObject } from '@agent/node';

class ExposedRetryNode extends RetryableInvocationNode<
  unknown,
  NonIterableObject,
  never
> {
  protected getOperationName(): string {
    return 'Tool-use call';
  }

  fallbackFor(error: Error): unknown {
    return this.getFallbackResult(error);
  }
}

describe('RetryState', () => {
  it('treats user aborts as cancellations instead of failed invocations', () => {
    const node = new ExposedRetryNode();
    const abort = new DOMException('Request aborted', 'AbortError');

    expect(node.shouldAutoRetry(abort)).toBe(false);
    expect(node.fallbackFor(abort)).toEqual({ kind: 'cancelled' });
  });
});
