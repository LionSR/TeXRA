import { describe, expect, it } from 'vitest';

import { resumeEntryDescription } from '@cli/chat/tui/forms/ResumeListForm';
import { CLI_HISTORY_RESUMABLE_STATUS } from '@cli/runtime/history';

describe('CLI ResumeListForm labels', () => {
  const TIMESTAMP = '2026-05-20T21:00:00.000Z';

  it.each([
    {
      name: 'summarizes the execution facts needed to choose a run',
      agent: 'polish',
      inputBasename: 'paper.tex',
      expected: `${TIMESTAMP}; polish; resumable; paper.tex`,
    },
    {
      name: 'uses human wording for sessions without an input file',
      agent: 'chat',
      inputBasename: '-',
      expected: `${TIMESTAMP}; chat; resumable; no input`,
    },
    {
      name: 'uses the history description for sessions without an input file',
      agent: 'chat',
      inputBasename: '-',
      description: 'Sketching inductive Lean proof of Nat.add_comm.',
      expected: `${TIMESTAMP}; chat; resumable; Sketching inductive Lean proof of Nat.add_comm.`,
    },
    {
      name: 'keeps input file names ahead of history descriptions',
      agent: 'polish',
      inputBasename: 'paper.tex',
      description: 'Rewrite the introduction.',
      expected: `${TIMESTAMP}; polish; resumable; paper.tex`,
    },
  ])('$name', ({ agent, inputBasename, description, expected }) => {
    expect(
      resumeEntryDescription({
        id: 'abc',
        timestamp: TIMESTAMP,
        agent,
        model: 'deepseekT',
        status: CLI_HISTORY_RESUMABLE_STATUS,
        inputBasename,
        description,
      }),
    ).toBe(expected);
  });
});
