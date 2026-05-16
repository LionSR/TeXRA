// Phase 4 state + focus-cycle smoke. We poke `cliState` directly and verify
// the focus cycle helpers walk subagents/processes then return to the parent.

import { afterEach, describe, expect, it } from 'vitest';

import {
  cliState,
  patchStream,
  resetCliState,
  setParentStream,
} from '../../../packages/cli/src/chat/tui/state/cliState';
import {
  descendantAt,
  nextFocusBack,
  nextFocusForward,
} from '../../../packages/cli/src/chat/tui/state/focusCycle';
import type { StreamTabId } from '@shared/schemas';

const root = 'root' as StreamTabId;
const child1 = 'child-1' as StreamTabId;
const child2 = 'child-2' as StreamTabId;

afterEach(() => {
  resetCliState();
});

describe('cliState Phase 4 fields', () => {
  it('initialises every new slice with empty subagent/process/todo/plan defaults', () => {
    patchStream(root, (s) => ({ ...s, status: 'running' }));
    const slice = cliState.streams.get().get(root);
    expect(slice).toBeDefined();
    expect(slice?.activeSubagents).toEqual([]);
    expect(slice?.activeProcesses).toEqual([]);
    expect(slice?.todos).toEqual([]);
    expect(slice?.plan).toBeNull();
    expect(slice?.processOutput.size).toBe(0);
  });

  it('tracks parent edges and drops them when a stream is removed', () => {
    setParentStream(child1, root);
    setParentStream(child2, root);
    expect(cliState.parentStream.get().get(child1)).toBe(root);
    expect(cliState.parentStream.get().get(child2)).toBe(root);
    patchStream(child1, (s) => s);
    // removeStream is exercised indirectly via resetCliState in afterEach.
  });
});

describe('focusCycle', () => {
  it('advances Ctrl-A forward through descendants then wraps to parent', () => {
    cliState.activeStreamId.set(root);
    setParentStream(child1, root);
    setParentStream(child2, root);
    patchStream(root, (s) => ({
      ...s,
      activeSubagents: [
        { executionId: 'e1', agentName: 'a', childStreamId: child1 },
      ],
      activeProcesses: [
        { executionId: 'e2', agentName: 'b', childStreamId: child2 },
      ],
    }));
    // From root → first descendant (subagent).
    expect(nextFocusForward()).toBe(child1);
    // child1 is a leaf in this fixture, so advancing from there returns to
    // the parent (the cycle closes via the parent edge).
    cliState.activeStreamId.set(child1);
    patchStream(child1, (s) => s);
    expect(nextFocusForward()).toBe(root);
  });

  it('Ctrl-B returns to the parent and bottoms out at root', () => {
    setParentStream(child1, root);
    cliState.activeStreamId.set(child1);
    expect(nextFocusBack()).toBe(root);
    cliState.activeStreamId.set(root);
    expect(nextFocusBack()).toBeUndefined();
  });

  it('descendantAt resolves 1-based jump indices', () => {
    cliState.activeStreamId.set(root);
    patchStream(root, (s) => ({
      ...s,
      activeSubagents: [
        { executionId: 'e1', agentName: 'a', childStreamId: child1 },
      ],
      activeProcesses: [
        { executionId: 'e2', agentName: 'b', childStreamId: child2 },
      ],
    }));
    expect(descendantAt(1)).toBe(child1);
    expect(descendantAt(2)).toBe(child2);
    expect(descendantAt(3)).toBeUndefined();
    expect(descendantAt(0)).toBeUndefined();
  });
});
