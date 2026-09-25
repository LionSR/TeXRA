import { describe, expect, it } from 'vitest';

import {
  isPlanApprovalGoalActionVisible,
  planApprovalGoalNoticeLine,
} from '@cli/chat/tui/modals/PlanApproval';
import { textDisplayWidth } from '@cli/runtime/terminalText';

describe('CLI plan approval layout', () => {
  it.each([
    { visibleBodyRows: 0, expected: false },
    { visibleBodyRows: 1, expected: false },
    { visibleBodyRows: 2, expected: true },
  ])(
    'hides run-as-goal when compact mode cannot show its scope notice ($visibleBodyRows rows)',
    ({ visibleBodyRows, expected }) => {
      expect(
        isPlanApprovalGoalActionVisible({
          compact: true,
          goalEnabled: true,
          visibleBodyRows,
        }),
      ).toBe(expected);
    },
  );

  it('keeps the goal explanation to one display row on narrow cards', () => {
    const notice = planApprovalGoalNoticeLine(40);

    expect(textDisplayWidth(notice)).toBe(40);
    expect(notice).toContain('until done');
    expect(notice).toContain('only Bash');
    expect(notice).not.toContain('…');
  });
});
