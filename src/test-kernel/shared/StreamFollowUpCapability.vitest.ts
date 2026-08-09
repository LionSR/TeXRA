import { describe, expect, it } from 'vitest';

import {
  AgentCategory,
  STREAM_PHASE,
  type RunIdentity,
  type StreamPhase,
} from '@shared/schemas';
import { streamAcceptsFollowUps } from '@shared/streams/followUpCapability';

describe('streamAcceptsFollowUps', () => {
  const inFlightPhases = [STREAM_PHASE.RUNNING, STREAM_PHASE.WAITING] as const;
  const terminalPhases = [
    STREAM_PHASE.COMPLETED,
    STREAM_PHASE.CANCELLED,
    STREAM_PHASE.FAILED,
  ] as const;

  it.each([
    ...inFlightPhases.map((status) => ({
      name: `native tool-use agent ${status}`,
      identity: { kind: 'agent' as const, agent: 'critic' },
      category: AgentCategory.ToolUse,
      status,
      expected: true,
    })),
    ...inFlightPhases.map((status) => ({
      name: `workflow agent ${status}`,
      identity: { kind: 'agent' as const, agent: 'review-workflow' },
      category: AgentCategory.Workflow,
      status,
      expected: false,
    })),
    ...inFlightPhases.map((status) => ({
      name: `multi-agent workflow ${status}`,
      identity: {
        kind: 'multiAgentWorkflow' as const,
        workflowName: 'review-workflow',
      },
      category: AgentCategory.Workflow,
      status,
      expected: false,
    })),
    ...inFlightPhases.map((status) => ({
      name: `Bash process ${status}`,
      identity: { kind: 'process' as const, tool: 'bash' },
      category: AgentCategory.ToolUse,
      status,
      expected: false,
    })),
    ...inFlightPhases.map((status) => ({
      name: `terminal-backed agent ${status}`,
      identity: { kind: 'agent' as const, agent: 'codex', tool: 'codex' },
      category: AgentCategory.ToolUse,
      status,
      expected: false,
    })),
    ...terminalPhases.map((status) => ({
      name: `native tool-use agent ${status}`,
      identity: { kind: 'agent' as const, agent: 'critic' },
      category: AgentCategory.ToolUse,
      status,
      expected: false,
    })),
  ])('$name: $expected', ({ category, expected, identity, status }) => {
    expect(streamAcceptsFollowUps({ category, identity, status })).toBe(
      expected,
    );
  });

  it.each([
    {
      name: 'identity',
      identity: undefined,
      category: AgentCategory.ToolUse,
      status: STREAM_PHASE.RUNNING,
    },
    {
      name: 'category',
      identity: { kind: 'agent' as const, agent: 'critic' },
      category: undefined,
      status: STREAM_PHASE.RUNNING,
    },
    {
      name: 'status',
      identity: { kind: 'agent' as const, agent: 'critic' },
      category: AgentCategory.ToolUse,
      status: undefined,
    },
  ] satisfies readonly {
    readonly name: string;
    readonly identity: RunIdentity | undefined;
    readonly category: AgentCategory | undefined;
    readonly status: StreamPhase | undefined;
  }[])('fails closed without $name', ({ category, identity, status }) => {
    expect(streamAcceptsFollowUps({ category, identity, status })).toBe(false);
  });
});
