// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - shared tool display
import { executionsSubagentSummary } from '@shared/tools/executionsDisplay';

const labels = new Map([
  ['sub-1', 'reviewer'],
  ['sub-2', 'leanSolver'],
]);

describe('executions tool display', () => {
  it('labels every subagent in a wait target list', () => {
    expect(
      executionsSubagentSummary(
        {
          action: 'wait',
          path: '/executions',
          ids: ['sub-1', 'sub-2'],
        },
        labels,
      ),
    ).toBe('wait: reviewer, leanSolver');
  });

  it('labels a subagent selected through a specific execution path', () => {
    expect(
      executionsSubagentSummary({ path: '/executions/sub-1/report' }, labels),
    ).toBe('view: reviewer/report');
    expect(
      executionsSubagentSummary(
        { path: '/executions/sub-1/workspace-files/review.md' },
        labels,
      ),
    ).toBe('view: reviewer/workspace-files/review.md');
  });

  it('keeps mixed wait targets complete', () => {
    expect(
      executionsSubagentSummary(
        { action: 'wait', path: '/executions', ids: ['sub-1', 'process-1'] },
        labels,
      ),
    ).toBe('wait: reviewer, process-1');
  });

  it('preserves the host title when every target is a process', () => {
    expect(
      executionsSubagentSummary(
        { action: 'wait', path: '/executions/process-1' },
        labels,
      ),
    ).toBeUndefined();
  });

  it('does not treat the current execution alias as a subagent id', () => {
    expect(
      executionsSubagentSummary({ path: '/executions/current' }, labels),
    ).toBeUndefined();
  });
});
