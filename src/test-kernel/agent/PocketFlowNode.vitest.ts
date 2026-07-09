import { afterEach, describe, expect, it, vi } from 'vitest';

import { BaseNode } from '@agent/node';
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
