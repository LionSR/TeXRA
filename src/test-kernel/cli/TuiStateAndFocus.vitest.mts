// Phase 4 state + focus-cycle smoke.

import { afterEach, describe, expect, it } from 'vitest';

import type { StreamTabId } from '@shared/schemas';

import {
  cliState,
  patchStream,
  removeStream,
  resetCliState,
  setParentStream,
} from '../../../packages/cli/src/chat/tui/state/cliState';
import {
  nextFocusBack,
  nextFocusForward,
} from '../../../packages/cli/src/chat/tui/state/focusCycle';

const root = 'root' as StreamTabId;
const child1 = 'child-1' as StreamTabId;
const child2 = 'child-2' as StreamTabId;

afterEach(() => {
  resetCliState();
});

describe('cliState Phase 4 fields', () => {
  it('initialises every new slice with empty subagent/process/todo/plan/bypass defaults', () => {
    patchStream(root, (s) => ({ ...s, status: 'running' }));
    const slice = cliState.streams.get().get(root);
    expect(slice).toBeDefined();
    expect(slice?.activeSubagents).toEqual([]);
    expect(slice?.activeProcesses).toEqual([]);
    expect(slice?.todos).toEqual([]);
    expect(slice?.plan).toBeNull();
    expect(slice?.processOutput.size).toBe(0);
    expect(slice?.bypass).toEqual({ toolEdit: false, superYolo: false });
  });

  it('prunes parent edges when a stream is removed', () => {
    setParentStream(child1, root);
    setParentStream(child2, root);
    expect(cliState.parentStream.get().get(child1)).toBe(root);
    expect(cliState.parentStream.get().get(child2)).toBe(root);

    // Removing a child drops its own edge but leaves siblings intact.
    patchStream(child1, (s) => ({ ...s, status: 'running' }));
    removeStream(child1);
    expect(cliState.parentStream.get().has(child1)).toBe(false);
    expect(cliState.parentStream.get().get(child2)).toBe(root);

    // Removing the parent prunes every edge that pointed at it.
    patchStream(root, (s) => ({ ...s, status: 'running' }));
    removeStream(root);
    expect(cliState.parentStream.get().has(child2)).toBe(false);
  });
});

describe('focusCycle', () => {
  it('Ctrl-A cycles through siblings then wraps back to the parent', () => {
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
    // root → first descendant.
    expect(nextFocusForward()).toBe(child1);
    // child1 → next sibling resolved through the parent's descendant list.
    cliState.activeStreamId.set(child1);
    expect(nextFocusForward()).toBe(child2);
    // child2 (last sibling) → wrap back to parent.
    cliState.activeStreamId.set(child2);
    expect(nextFocusForward()).toBe(root);
  });

  it('Ctrl-B returns to the parent and bottoms out at root', () => {
    setParentStream(child1, root);
    cliState.activeStreamId.set(child1);
    expect(nextFocusBack()).toBe(root);
    cliState.activeStreamId.set(root);
    expect(nextFocusBack()).toBeUndefined();
  });
});
