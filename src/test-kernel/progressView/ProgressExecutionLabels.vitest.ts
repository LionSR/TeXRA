// Third-party imports
import { afterEach, describe, expect, it } from 'vitest';

// Local imports
import {
  appState,
  logContext$,
  resetProgressState,
} from '@progressView/frontend/progressState';
import { createInitialState } from '@progressView/frontend/store';
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
  agent: 'builtInToolUse:reviewer',
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

const completedWorkflowScript: StreamTabInfo = {
  kind: 'workflowScript',
  name: 'repo-cleanup#workflow-1',
  label: 'repo-cleanup-readonly-pilot-2026-07-24',
  workflowName: 'repo-cleanup-readonly-pilot-2026-07-24',
  agentCategory: AgentCategory.Workflow,
  creationTimestamp: 3,
  executionId: 'workflow-1',
  parentStreamId: 'parent',
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

  it('labels child workflow-script executions with the script name', () => {
    appState.set({
      ...createInitialState(),
      activeStreamId: 'parent',
      streamById: new Map<string, StreamTabInfo>([
        ['parent', parent],
        [completedWorkflowScript.name, completedWorkflowScript],
      ]),
    });

    expect(logContext$.get().subagentExecutionLabels?.get('workflow-1')).toBe(
      'repo-cleanup-readonly-pilot-2026-07-24',
    );
  });
});
