// Test composition imports

// Third-party imports
import { describe, expect, it } from 'vitest';
import { Effect } from 'effect';

// Local imports
import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import {
  aggregateId,
  emptyRunEndOutput,
  RunIdSchema,
  STATUS_DISPLAY,
  TODO_STATUS,
} from '@shared/schemas';
import {
  createTestSession,
  publishTestRunStart,
} from '@test/support/sessionTestUtils';
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
    const session = createTestSession();
    const parentRunId = RunIdSchema.parse('fcf5150d37c6');
    const runId = RunIdSchema.parse('16c0f3f748e4');
    publishTestRunStart(session, parentRunId);
    session.publish([
      {
        type: 'run.start',
        aggregateId: aggregateId('run', runId),
        identity: { kind: 'process', tool: 'bash' },
        category: 'toolUse',
        userFollowUpSupport: 'unsupported',
        isRemote: false,
        parent: { id: parentRunId },
      },
      {
        type: 'run.config',
        aggregateId: aggregateId('run', runId),
        config: AgentConfigSchema.parse({
          agent: 'bash',
          model: 'gemini31p',
          instruction: 'ls',
          agentCategory: 'toolUse',
        }),
      },
      {
        type: 'run.end',
        aggregateId: aggregateId('run', runId),
        outcome: 'completed',
        output: emptyRunEndOutput('toolUse'),
      },
    ]);
    await Effect.runPromise(session.settlePublications());
    const view = await Effect.runPromise(session.readView([runId]));

    // The row's recorded outcome is the status; the columns under test are
    // the `process` category and the model a non-agent identity suppresses.
    const line = formatListingLine(view.runs.get(runId)!);
    await Effect.runPromise(session.dispose());

    expect(line).toContain(`${runId}  `);
    expect(line).toContain('bash  process  [completed]');
    expect(line).toContain(`parent=${parentRunId}`);
    expect(line).not.toContain('gemini31p');
  });
});
