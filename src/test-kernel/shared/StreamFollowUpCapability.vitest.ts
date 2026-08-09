import { describe, expect, it } from 'vitest';

import {
  AgentCategory,
  STREAM_PHASE,
  USER_FOLLOW_UP_SUPPORT,
  type RunIdentity,
  type StreamPhase,
  type UserFollowUpSupport,
} from '@shared/schemas';
import { streamAllowsChildFollowUpComposer } from '@shared/streams/followUpCapability';

describe('streamAllowsChildFollowUpComposer', () => {
  const inFlightPhases = [STREAM_PHASE.RUNNING, STREAM_PHASE.WAITING] as const;
  const terminalPhases = [
    STREAM_PHASE.COMPLETED,
    STREAM_PHASE.CANCELLED,
    STREAM_PHASE.FAILED,
  ] as const;

  it.each([
    ...inFlightPhases.map((status) => ({
      name: `ordinary native tool-use agent ${status}`,
      identity: { kind: 'agent' as const, agent: 'critic' },
      userFollowUpSupport: USER_FOLLOW_UP_SUPPORT.NATIVE_INTERACTIVE,
      category: AgentCategory.ToolUse,
      status,
      expected: true,
    })),
    ...inFlightPhases.map((status) => ({
      name: `structured single-cycle workflow call ${status}`,
      identity: { kind: 'agent' as const, agent: 'critic' },
      userFollowUpSupport: USER_FOLLOW_UP_SUPPORT.UNSUPPORTED,
      category: AgentCategory.ToolUse,
      status,
      expected: false,
    })),
    ...inFlightPhases.map((status) => ({
      name: `workflow agent ${status}`,
      identity: { kind: 'agent' as const, agent: 'review-workflow' },
      userFollowUpSupport: USER_FOLLOW_UP_SUPPORT.UNSUPPORTED,
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
      userFollowUpSupport: USER_FOLLOW_UP_SUPPORT.UNSUPPORTED,
      category: AgentCategory.Workflow,
      status,
      expected: false,
    })),
    ...inFlightPhases.map((status) => ({
      name: `Bash process ${status}`,
      identity: { kind: 'process' as const, tool: 'bash' },
      userFollowUpSupport: USER_FOLLOW_UP_SUPPORT.UNSUPPORTED,
      category: AgentCategory.ToolUse,
      status,
      expected: false,
    })),
    ...inFlightPhases.map((status) => ({
      name: `terminal-backed runtime-supported agent ${status}`,
      identity: { kind: 'agent' as const, agent: 'codex', tool: 'codex' },
      userFollowUpSupport: USER_FOLLOW_UP_SUPPORT.TERMINAL_BACKED,
      category: AgentCategory.ToolUse,
      status,
      expected: false,
    })),
    ...terminalPhases.map((status) => ({
      name: `native tool-use agent ${status}`,
      identity: { kind: 'agent' as const, agent: 'critic' },
      userFollowUpSupport: USER_FOLLOW_UP_SUPPORT.NATIVE_INTERACTIVE,
      category: AgentCategory.ToolUse,
      status,
      expected: false,
    })),
  ])(
    '$name: $expected',
    ({ category, expected, identity, status, userFollowUpSupport }) => {
      expect(
        streamAllowsChildFollowUpComposer({
          category,
          identity,
          status,
          userFollowUpSupport,
        }),
      ).toBe(expected);
    },
  );

  it.each([
    {
      name: 'identity',
      identity: undefined,
      userFollowUpSupport: USER_FOLLOW_UP_SUPPORT.NATIVE_INTERACTIVE,
      category: AgentCategory.ToolUse,
      status: STREAM_PHASE.RUNNING,
    },
    {
      name: 'runtime support',
      identity: { kind: 'agent' as const, agent: 'critic' },
      userFollowUpSupport: undefined,
      category: AgentCategory.ToolUse,
      status: STREAM_PHASE.RUNNING,
    },
    {
      name: 'category',
      identity: { kind: 'agent' as const, agent: 'critic' },
      userFollowUpSupport: USER_FOLLOW_UP_SUPPORT.NATIVE_INTERACTIVE,
      category: undefined,
      status: STREAM_PHASE.RUNNING,
    },
    {
      name: 'status',
      identity: { kind: 'agent' as const, agent: 'critic' },
      userFollowUpSupport: USER_FOLLOW_UP_SUPPORT.NATIVE_INTERACTIVE,
      category: AgentCategory.ToolUse,
      status: undefined,
    },
  ] satisfies readonly {
    readonly name: string;
    readonly identity: RunIdentity | undefined;
    readonly userFollowUpSupport: UserFollowUpSupport | undefined;
    readonly category: AgentCategory | undefined;
    readonly status: StreamPhase | undefined;
  }[])(
    'fails closed without $name',
    ({ category, identity, status, userFollowUpSupport }) => {
      expect(
        streamAllowsChildFollowUpComposer({
          category,
          identity,
          status,
          userFollowUpSupport,
        }),
      ).toBe(false);
    },
  );
});
