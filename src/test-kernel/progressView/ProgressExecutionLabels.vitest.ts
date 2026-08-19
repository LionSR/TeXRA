// Third-party imports
import { afterEach, describe, expect, it } from 'vitest';

// Local imports
import {
  appState,
  resetProgressState,
  subagentExecutionLabels,
} from '@progressView/frontend/progressState';
import { createInitialState } from '@progressView/frontend/store';
import {
  AgentCategory,
  type StreamTabId,
  type StreamTabInfo,
} from '@shared/schemas';
import type { ExecutionLabels } from '@shared/tools/executionsDisplay';

const parent: StreamTabInfo = {
  name: 'parent',
  label: 'parent',
  identity: { kind: 'agent', agent: 'root' },
  agentCategory: AgentCategory.ToolUse,
  creationTimestamp: 1,
};

const completedChild: StreamTabInfo = {
  name: 'reviewer#sub-1',
  label: 'reviewer',
  identity: { kind: 'agent', agent: 'builtInToolUse:reviewer' },
  agentCategory: AgentCategory.ToolUse,
  creationTimestamp: 2,
  executionId: 'sub-1',
  parentStreamId: 'parent',
};

const completedSibling: StreamTabInfo = {
  ...completedChild,
  name: 'leanSolver#sub-2',
  label: 'leanSolver',
  identity: { kind: 'agent', agent: 'leanSolver' },
  executionId: 'sub-2',
};

const completedWorkflowScript: StreamTabInfo = {
  name: 'repo-cleanup#workflow-1',
  label: 'repo-cleanup-readonly-pilot-2026-07-24',
  identity: {
    kind: 'multiAgentWorkflow',
    workflowName: 'repo-cleanup-readonly-pilot-2026-07-24',
  },
  agentCategory: AgentCategory.Workflow,
  creationTimestamp: 3,
  executionId: 'workflow-1',
  parentStreamId: 'parent',
};

function seedStreams(
  activeStreamId: StreamTabId,
  streams: StreamTabInfo[],
): ExecutionLabels {
  appState.set({
    ...createInitialState(),
    activeStreamId,
    streamById: new Map(
      streams.map((stream) => [stream.name as StreamTabId, stream]),
    ),
  });
  return subagentExecutionLabels(appState.get().streamById.values());
}

afterEach(resetProgressState);

describe('progress executions labels', () => {
  it('retains child-stream identities after the active roster is empty', () => {
    const labels = seedStreams('parent' as StreamTabId, [
      parent,
      completedChild,
    ]);

    expect(labels.get('sub-1')).toBe('reviewer');
  });

  it('exposes sibling identities while a subagent tab is active', () => {
    const labels = seedStreams(completedChild.name as StreamTabId, [
      parent,
      completedChild,
      completedSibling,
    ]);

    expect(labels.get('sub-2')).toBe('leanSolver');
  });

  it('does not label child process streams as subagents', () => {
    const process: StreamTabInfo = {
      ...completedChild,
      identity: { kind: 'process', tool: 'bash' },
      name: 'bash#process-1',
      label: 'bash',
      executionId: 'process-1',
    };
    const labels = seedStreams('parent' as StreamTabId, [parent, process]);

    expect(labels.size).toBe(0);
  });

  it('labels child workflow-script executions with the script name', () => {
    const labels = seedStreams('parent' as StreamTabId, [
      parent,
      completedWorkflowScript,
    ]);

    expect(labels.get('workflow-1')).toBe(
      'repo-cleanup-readonly-pilot-2026-07-24',
    );
  });
});
