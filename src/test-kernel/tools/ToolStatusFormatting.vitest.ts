// Test composition imports
import '@test/support/defaultSessionTestSetup';

// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports
import type { ExecutionListingEntry } from '@agent/storage';
import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import { STATUS_DISPLAY, TODO_STATUS } from '@shared/schemas';
import { formatSubagentProgress } from '@shared/subagentFollowup';
import {
  formatListingLine,
  formatTodoSection,
} from '@tools/executionFormatters';
import { formatSubagentError } from '@tools/delegation/subagentResults';

describe('tool status formatting', () => {
  it('formats execution todos with the shared status display', () => {
    expect(
      formatTodoSection([
        { content: 'Write proof', status: TODO_STATUS.COMPLETED },
        { content: 'Check constants', status: TODO_STATUS.IN_PROGRESS },
        { content: 'Unknown state', status: 'deferred' },
      ]),
    ).toEqual([
      `${STATUS_DISPLAY[TODO_STATUS.COMPLETED].icon} Write proof`,
      `${STATUS_DISPLAY[TODO_STATUS.IN_PROGRESS].icon} Check constants`,
      `${STATUS_DISPLAY[TODO_STATUS.PENDING].icon} Unknown state`,
    ]);
  });

  it('formats subagent todos with the shared status display', () => {
    const progress = formatSubagentProgress('exec-1', 'review', {
      kind: 'todos',
      todos: [
        {
          content: 'Inspect lemma',
          status: TODO_STATUS.COMPLETED,
          activeForm: 'Inspecting lemma',
        },
        {
          content: 'Write response',
          status: TODO_STATUS.PENDING,
          activeForm: 'Writing response',
        },
      ],
    });

    expect(progress).toContain(
      `  ${STATUS_DISPLAY[TODO_STATUS.COMPLETED].icon} Inspect lemma`,
    );
    expect(progress).toContain(
      `  ${STATUS_DISPLAY[TODO_STATUS.PENDING].icon} Write response`,
    );
  });

  it('marks retryable subagent errors in the orchestrator delivery', () => {
    const delivery = formatSubagentError(
      'exec-1',
      'leanSimplifier',
      new Error('No output generated - API returned empty response'),
    );

    expect(delivery).toContain(
      '<subagent-error id="exec-1" agent="leanSimplifier" retryable="true">',
    );
    expect(delivery).toContain(
      '<message>No output generated - API returned empty response</message>',
    );
  });

  it('includes attached memory misses in subagent error delivery', () => {
    const delivery = formatSubagentError(
      'exec-1',
      'review',
      new Error('subagent failed'),
      {
        memoryMisses: [
          {
            path: '/memories/missing.md',
            reason: 'Path is missing & unreadable',
          },
        ],
      },
    );

    expect(delivery).toContain('<memory-misses>');
    expect(delivery).toContain(
      '<memory-miss path="/memories/missing.md" reason="Path is missing &amp; unreadable" />',
    );
  });

  it('renders bash execution history as a process without a model', () => {
    const entry: ExecutionListingEntry = {
      kind: 'run',
      identity: { kind: 'process', tool: 'bash' },
      id: '16c0f3f748e4',
      timestamp: '2026-05-15T23:42:06.000Z',
      parentExecutionId: 'fcf5150d37c6',
      record: AgentConfigSchema.parse({
        agent: 'bash',
        model: 'gemini31p',
        instruction: 'ls',
        agentCategory: 'toolUse',
      }),
      outcome: 'completed',
    };

    expect(formatListingLine(entry)).toBe(
      '16c0f3f748e4  2026-05-15 23:42:06  bash  process  [completed]  parent=fcf5150d37c6',
    );
  });
});
