// Third-party imports
import { afterEach, describe, expect, it } from 'vitest';

// Local imports - progress view state
import {
  appState,
  logContext$,
  resetProgressState,
} from '@progressView/frontend/progressState';
import { createInitialState } from '@progressView/frontend/store';

// Local imports - shared schemas
import { AgentCategory, type StreamTabInfo } from '@shared/schemas';

const parent: StreamTabInfo = {
  kind: 'agent',
  name: 'parent',
  label: 'parent',
  agent: 'root',
  agentCategory: AgentCategory.ToolUse,
  creationTimestamp: 1,
};

const completedChild: StreamTabInfo = {
  kind: 'agent',
  name: 'reviewer#sub-1',
  label: 'reviewer',
  agent: 'reviewer',
  agentCategory: AgentCategory.ToolUse,
  creationTimestamp: 2,
  executionId: 'sub-1',
  parentStreamId: 'parent',
};

const completedSibling: StreamTabInfo = {
  ...completedChild,
  name: 'leanSolver#sub-2',
  label: 'leanSolver',
  agent: 'leanSolver',
  executionId: 'sub-2',
};

afterEach(resetProgressState);

describe('progress executions labels', () => {
  it('retains child-stream identities after the active roster is empty', () => {
    appState.set({
      ...createInitialState(),
      activeStreamId: 'parent',
      streamById: new Map<string, StreamTabInfo>([
        ['parent', parent],
        ['reviewer#sub-1', completedChild],
      ]),
    });

    expect(logContext$.get().subagentExecutionLabels?.get('sub-1')).toBe(
      'reviewer',
    );
  });

  it('exposes sibling identities while a subagent tab is active', () => {
    appState.set({
      ...createInitialState(),
      activeStreamId: completedChild.name,
      streamById: new Map<string, StreamTabInfo>([
        ['parent', parent],
        [completedChild.name, completedChild],
        [completedSibling.name, completedSibling],
      ]),
    });

    expect(logContext$.get().subagentExecutionLabels?.get('sub-2')).toBe(
      'leanSolver',
    );
  });

  it('does not label child process streams as subagents', () => {
    const process: StreamTabInfo = {
      ...completedChild,
      kind: 'process',
      name: 'bash#process-1',
      label: 'bash',
      agent: 'bash',
      executionId: 'process-1',
    };
    appState.set({
      ...createInitialState(),
      activeStreamId: 'parent',
      streamById: new Map<string, StreamTabInfo>([
        ['parent', parent],
        ['bash#process-1', process],
      ]),
    });

    expect(logContext$.get().subagentExecutionLabels?.size).toBe(0);
  });
});
