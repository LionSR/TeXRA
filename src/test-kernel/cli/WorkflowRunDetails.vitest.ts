import { describe, expect, it } from 'vitest';

import { selectWorkflowRunDetailLines } from '@cli/chat/tui/panes/WorkflowRunDetails';
import { PENDING_BOX } from '@cli/tui/ui/glyphs';
import type { CompileFailure } from '@texra/shared/plugins/documentOutputs';

const COMPILE_FAILURE: CompileFailure = {
  round: 0,
  displayName: 'paper.pdf',
  output: {
    kind: 'external',
    absolutePath: '/tmp/paper.pdf',
  },
  log: {
    kind: 'external',
    absolutePath: '/tmp/paper.log',
  },
  logRelativePath: 'paper.log',
};

const COMPILE_FAILURES_BY_ROUND = { 0: [COMPILE_FAILURE] };

describe('selectWorkflowRunDetailLines', () => {
  it('does not show a results row from an unvalidated empty missing-output round', () => {
    const lines = selectWorkflowRunDetailLines(
      {
        taskGroups: [],
        outputFilesByRound: {},
        missingOutputsByRound: { 0: [] },
        compileFailuresByRound: {},
        latexdiffsByRound: {},
        repliesByRound: {},
      },
      100,
    );

    expect(lines).toEqual([]);
  });

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

  it('shows a round-qualified alert when only one detail row fits', () => {
    const [line] = selectWorkflowRunDetailLines(
      {
        taskGroups: [],
        outputFilesByRound: {},
        missingOutputsByRound: { 0: ['missing.tex'] },
        compileFailuresByRound: COMPILE_FAILURES_BY_ROUND,
        latexdiffsByRound: {},
        repliesByRound: {},
      },
      1,
    );

    expect(line?.text).toBe(
      '  ✗ r1 · Compile check failed: paper.pdf · paper.log',
    );
    expect(line?.role).toBe('alert');
  });
});
