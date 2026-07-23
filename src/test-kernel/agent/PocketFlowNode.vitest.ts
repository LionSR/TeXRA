import { afterEach, describe, expect, it, vi } from 'vitest';

import { BaseNode, Node } from '@agent/node';
import * as logger from '@logger/logUtils';

class TestNode extends BaseNode<Record<string, never>> {}

describe('BaseNode.getNextNode', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(['complete', 'finalize'] as const)(
    "returns undefined silently for the terminal action '%s' when unregistered",
    (action) => {
      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      const node = new TestNode();
      // Register an unrelated successor so `_successors.size > 0`, which is
      // the branch that would otherwise trigger the "Flow ends" warning.
      node.on('default', new TestNode());

      expect(node.getNextNode(action)).toBeUndefined();
      expect(warnSpy).not.toHaveBeenCalled();
    },
  );

  it('warns when a non-terminal unregistered action falls through', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const node = new TestNode();
    node.on('default', new TestNode());

    expect(node.getNextNode('unregistered-action')).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      'PocketFlow',
      expect.stringContaining(
        "Flow ends: 'unregistered-action' not found in [default]",
      ),
    );
  });

  it('does not warn when no successors are registered at all', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const node = new TestNode();

    expect(node.getNextNode('anything')).toBeUndefined();
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

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
