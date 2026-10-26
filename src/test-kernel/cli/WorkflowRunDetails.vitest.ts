import { describe, expect, it } from 'vitest';

import { selectWorkflowRunDetailLines } from '@cli/chat/tui/panes/WorkflowRunDetails';
import { PENDING_BOX } from '@cli/tui/ui/glyphs';

describe('selectWorkflowRunDetailLines', () => {
  it('renders a round and sanitizes terminal controls', () => {
    const lines = selectWorkflowRunDetailLines(
      {
        taskGroups: [],
        outputFilesByRound: {},
        missingOutputsByRound: { 3: ['bad\u001b[31m.tex'] },
        compileFailuresByRound: {},
        latexdiffsByRound: {},
        repliesByRound: {},
      },
      100,
    );

    expect(lines.map((line) => line.text)).toEqual([
      `${PENDING_BOX} r4 results`,
      '  ⚠ r4 · Missing output: bad.tex',
    ]);
  });
});
