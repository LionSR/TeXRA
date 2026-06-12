import { describe, expect, it } from 'vitest';

import {
  COMPACT_PLAN_APPROVAL_MAX_ROWS,
  isCompactPlanApprovalRows,
  planApprovalDisplayLines,
  renderCompactPlanLine,
} from '@cli/chat/tui/modals/PlanApproval';

describe('CLI plan approval layout', () => {
  it('switches to compact rendering before the bordered card clips plan text', () => {
    expect(COMPACT_PLAN_APPROVAL_MAX_ROWS).toBe(7);
    expect(isCompactPlanApprovalRows(7)).toBe(true);
    expect(isCompactPlanApprovalRows(8)).toBe(false);
  });

  it('uses a clear overflow label when compact clipping lands on a blank line', () => {
    expect(renderCompactPlanLine('', true, 3)).toBe('… 3 more lines');
  });

  it('keeps the visible line when compact clipping lands on content', () => {
    expect(renderCompactPlanLine('Verify typecheck', true, 2)).toBe(
      'Verify typecheck · … 2 more',
    );
  });

  it('wraps body lines before Ink renders the bordered card', () => {
    const lines = planApprovalDisplayLines({
      objective:
        '**Approach:** Keep a running mental log of friction points as tasks progress. At natural stopping points, call `todo_write` to record specific observations. Do not edit any files — only observe and report.',
      width: 77,
    });

    expect(lines.some((line) => line.startsWith(' At natural'))).toBe(false);
    expect(
      lines.some((line) => line.includes('observations. Do not edit')),
    ).toBe(true);
  });

  it('pads non-compact wrapped lines so shorter repaint rows clear stale tails', () => {
    const lines = planApprovalDisplayLines({
      objective: [
        '## Objective',
        'Prove that $\\sqrt{2} + \\sqrt{3}$ is irrational.',
        '',
        '## Approach',
        '1. Assume, for contradiction, that $\\sqrt{2} + \\sqrt{3}$ is rational, i.e. $x = \\sqrt{2} + \\sqrt{3} \\in \\mathbb{Q}$.',
        '2. Square both sides and isolate terms to derive a contradiction about $\\sqrt{6}$.',
        '3. Conclude that the original number is irrational.',
        "4. Delegate a brief independent verification to the `review` subagent to check the derivation's correctness.",
      ].join('\n'),
      width: 76,
      padLines: true,
    });

    expect(
      lines.some(
        (line) =>
          line.trim() ===
          '4. Delegate a brief independent verification to the `review` subagent to',
      ),
    ).toBe(true);
    const continuation = lines.find((line) =>
      line.trim().startsWith("check the derivation's correctness."),
    );
    expect(continuation).toBeDefined();
    expect(continuation).not.toContain('ification to the `review`');
    expect(continuation?.length).toBe(76);
  });
});
