import { describe, expect, it } from 'vitest';

import { tipRowText } from '@cli/chat/tui/panes/TipRow';

describe('CLI TipRow', () => {
  it('keeps root agent tips hidden after agent selection closes', () => {
    expect(
      tipRowText({ agentSelectionAvailable: false, hour: 2 }),
    ).not.toContain('/agent');
  });

  it('shows root agent selection as an up-front setup action', () => {
    expect(tipRowText({ agentSelectionAvailable: true, hour: 2 })).toBe(
      'Press /agent to choose the root agent',
    );
  });
});
