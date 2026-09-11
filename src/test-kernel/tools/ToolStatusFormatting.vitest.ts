// Test composition imports
import '@test/support/defaultSessionTestSetup';

// Third-party imports
import { describe, expect, it } from 'vitest';
import { Effect } from 'effect';
import type { RunListingEntry } from '@agent/storage';
import { defaultSession } from '@agent/runtime/SessionHandle';

// Local imports
import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import { STATUS_DISPLAY, TODO_STATUS, type RunId } from '@shared/schemas';
import { formatSubagentProgress } from '@shared/subagentFollowup';
import {
  formatListingLine,
  formatTodoSection,
} from '@tools/executionFormatters';

describe('tool status formatting', () => {
  it('formats run todos with the shared status display', () => {
    expect(
      formatTodoSection([
        {
          content: 'Write proof',
          status: TODO_STATUS.COMPLETED,
          activeForm: 'Writing proof',
        },
        {
          content: 'Check constants',
          status: TODO_STATUS.IN_PROGRESS,
          activeForm: 'Checking constants',
        },
      ]),
    ).toEqual([
      `${STATUS_DISPLAY[TODO_STATUS.COMPLETED].icon} Write proof`,
      `${STATUS_DISPLAY[TODO_STATUS.IN_PROGRESS].icon} Check constants`,
    ]);
  });

  it('renders bash run history as a process without a model', async () => {
    const entry: RunListingEntry = {
      kind: 'run',
      identity: { kind: 'process', tool: 'bash' },
      id: '16c0f3f748e4' as RunId,
      timestamp: '2026-05-15T23:42:06.000Z',
      parentRunId: 'fcf5150d37c6' as RunId,
      record: AgentConfigSchema.parse({
        agent: 'bash',
        model: 'gemini31p',
        instruction: 'ls',
        agentCategory: 'toolUse',
      }),
      outcome: 'completed',
      checkpointPresent: false,
    };

    // The row's own `outcome` is a recorded durable fact, so the status column
    // shows it without re-reading the metadata file it came from. The other
    // columns under test are the `process` category and the suppressed model.
    await expect(
      Effect.runPromise(formatListingLine(entry, defaultSession())),
    ).resolves.toBe(
      '16c0f3f748e4  2026-05-15 23:42:06  bash  process  [completed]  parent=fcf5150d37c6',
    );
  });
});
