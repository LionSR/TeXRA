// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports
import { Node } from '@agent/node';

class ApprovedRetryNode extends Node {
  calls = 0;

  override async exec(): Promise<string> {
    this.calls += 1;
    if (this.calls <= 101) throw new Error('temporary failure');
    return 'completed';
  }

  override async retryPrompt(): Promise<boolean> {
    return true;
  }
}

describe('Node manual retry', () => {
  it('continues beyond the former 100-approval ceiling', async () => {
    const node = new ApprovedRetryNode(1, 0);

    await expect(node._exec(undefined)).resolves.toBe('completed');
    expect(node.calls).toBe(102);
  });
});
