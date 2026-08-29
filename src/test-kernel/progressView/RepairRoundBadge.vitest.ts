// Third-party imports
import { describe, expect, it } from 'vitest';

// Local file imports
import { useLitComponentTestDom } from '../settings/litComponentTestUtils';

/**
 * Regression coverage for the reviewer finding on PR #7290 (issue #7077's
 * bounded compile-repair round): when the repair round is granted,
 * `currentRound` becomes `totalRounds` (one index past the configured last
 * round), so `runReflectionFlow.ts`'s `createRoundStage` callback widens the
 * stage's `total` for that round. This confirms the widened stage renders a
 * sensible badge rather than an over-total "Round 3 of 2".
 *
 * The flow mechanics that grant the repair round are covered by
 * `RoundPersistedFlowCompileRepair.vitest.ts`.
 */
describe('repair-round progress badge (PR #7290 follow-up)', () => {
  useLitComponentTestDom();

  it('renders a sensible, non-over-total badge for the widened repair-round stage', async () => {
    const { renderProgressBadgeContent, getProgressBadgeTitle } = await import(
      '@progressView/frontend/formatters/progressBadgeFormatter'
    );
    const { render } = await import('lit');

    // The repair round as opened by createRoundStage: index 2 (0-based, the
    // round past the configured totalRounds: 2), total widened to 3 via
    // Math.max(totalRounds, roundIndex + 1).
    const stage = { kind: 'round', index: 2, total: 3 } as const;

    const container = document.createElement('div');
    render(renderProgressBadgeContent(undefined, stage), container);
    expect(container.textContent).toBe('r3/3');
    expect(getProgressBadgeTitle(undefined, stage)).toBe('Round 3 of 3');
  });
});
