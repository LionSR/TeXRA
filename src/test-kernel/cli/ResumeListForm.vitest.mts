import { describe, expect, it } from 'vitest';

import {
  resumeEntryDescription,
  resumeSelectWindow,
} from '@cli/chat/tui/forms/ResumeListForm';
import { CLI_HISTORY_RESUMABLE_STATUS } from '@cli/runtime/history';

describe('CLI ResumeListForm row budget', () => {
  it('windows long execution lists inside the available foreground rows', () => {
    expect(resumeSelectWindow({ availableRows: 10, itemCount: 12 })).toEqual({
      maxVisibleItems: 1,
      showOverflow: true,
    });
  });

  it('uses the full list when it fits', () => {
    expect(resumeSelectWindow({ availableRows: 12, itemCount: 4 })).toEqual({
      maxVisibleItems: 4,
      showOverflow: false,
    });
  });
});

describe('CLI ResumeListForm labels', () => {
  it('summarizes the execution facts needed to choose a run', () => {
    expect(
      resumeEntryDescription({
        id: 'abc',
        timestamp: '2026-05-20T21:00:00.000Z',
        agent: 'polish',
        model: 'deepseekT',
        status: CLI_HISTORY_RESUMABLE_STATUS,
        inputBasename: 'paper.tex',
      }),
    ).toBe('2026-05-20T21:00:00.000Z; polish; resumable; paper.tex');
  });

  it('uses human wording for sessions without an input file', () => {
    expect(
      resumeEntryDescription({
        id: 'abc',
        timestamp: '2026-05-20T21:00:00.000Z',
        agent: 'chat',
        model: 'deepseekT',
        status: CLI_HISTORY_RESUMABLE_STATUS,
        inputBasename: '-',
      }),
    ).toBe('2026-05-20T21:00:00.000Z; chat; resumable; no input');
  });
});
