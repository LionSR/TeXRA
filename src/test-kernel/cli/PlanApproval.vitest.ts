import { describe, expect, it } from 'vitest';

import { PlanApproval } from '@cli/chat/tui/modals/PlanApproval';
import type { RunId } from '@shared/schemas';
import {
  loadInk,
  renderOutputAtTerminalSize,
} from '@test/support/inkTestHarness.ts';

async function renderPlanApproval(availableRows: number): Promise<string> {
  const { ink, React } = await loadInk();
  return renderOutputAtTerminalSize(
    ink,
    React.createElement(PlanApproval, {
      autoApproveAll: false,
      availableRows,
      onDecide: () => undefined,
      payload: {
        requestId: 'plan-1',
        runId: 'run-1' as RunId,
        plan: { objective: 'Verify the derivation.' },
      },
    }),
    60,
    { until: (output) => output.includes('Approve plan?') },
  );
}

describe('CLI plan approval layout', () => {
  it('goes compact before the bordered card clips, and drops run-as-goal without body room', async () => {
    // Goal approval adds two notice rows to the compact threshold (7 + 2).
    const bordered = await renderPlanApproval(10);
    expect(bordered).toContain('╔');
    expect(bordered).toContain('run as goal');

    const compact = await renderPlanApproval(9);
    expect(compact).not.toContain('╔');
    expect(compact).toContain('run as goal');

    // Two chrome rows at 60 columns leave one body row: too few for the
    // goal notice plus a plan row, so the action is withheld.
    const cramped = await renderPlanApproval(3);
    expect(cramped).not.toContain('╔');
    expect(cramped).not.toContain('run as goal');
  });
});
