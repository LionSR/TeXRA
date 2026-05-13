// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - schemas
import { STATUS_DISPLAY, TODO_STATUS } from '@shared/schemas';

// Local imports - tools
import { formatTodoSection } from '@tools/executionFormatters';
import { formatSubagentProgress } from '@tools/subagentResults';

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
});
