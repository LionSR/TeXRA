import { describe, expect, it } from 'vitest';

import {
  formatWorkflowCallMetadataParts,
  formatWorkflowCallLine,
  workflowCallTally,
} from '@shared/copy/workflowCall';

describe('workflow call copy', () => {
  it('uses one terminal metadata representation across hosts', () => {
    expect(
      formatWorkflowCallMetadataParts({
        id: 'draft',
        label: 'Draft',
        status: 'completed',
        model: 'gpt56',
        durationMs: 7_320,
        totalCostUsd: 0.04,
      }),
    ).toEqual(['gpt56', '7s', '$0.040']);
  });

  it('does not attach terminal metadata to an active call', () => {
    expect(
      formatWorkflowCallMetadataParts({
        id: 'draft',
        label: 'Draft',
        status: 'running',
      }),
    ).toEqual([]);
  });

  it('uses one failed-task line across textual hosts', () => {
    expect(
      formatWorkflowCallLine({
        id: 'audit',
        label: 'Audit source',
        status: 'failed',
        error: 'Runner stopped.',
        model: 'kimiK2',
        durationMs: 7_320,
        totalCostUsd: 0.04,
      }),
    ).toBe('Failed: Audit source · kimiK2 · 7s · $0.040 — Runner stopped.');
  });

  it('explains a call the run never reached on every textual host', () => {
    expect(
      formatWorkflowCallLine({
        id: 'audit',
        label: 'Audit later',
        status: 'skipped',
        reason: 'not-reached',
      }),
    ).toBe(
      'Skipped: Audit later — The workflow ended before this call was reached.',
    );
  });

  it('counts an empty phase as no work rather than complete', () => {
    expect(workflowCallTally([])).toEqual({
      done: 0,
      total: 0,
      running: 0,
      failed: 0,
    });
  });

  it('tallys no failures for a clean or empty run', () => {
    expect(workflowCallTally([])).toMatchObject({ failed: 0 });
    expect(
      workflowCallTally([
        { id: 'a', label: 'A', status: 'completed', durationMs: 1 },
        { id: 'b', label: 'B', status: 'running' },
      ]),
    ).toMatchObject({ failed: 0, running: 1 });
  });

  it('tallys only failed calls across a mixed run', () => {
    expect(
      workflowCallTally([
        { id: 'a', label: 'A', status: 'completed', durationMs: 1 },
        { id: 'b', label: 'B', status: 'failed', error: 'boom' },
        { id: 'c', label: 'C', status: 'skipped', reason: 'not-reached' },
        { id: 'd', label: 'D', status: 'failed', error: 'also boom' },
      ]),
    ).toMatchObject({ failed: 2 });
  });

  it('counts every terminal status as done, not just completions', () => {
    expect(
      workflowCallTally([
        { id: 'a', label: 'A', status: 'completed', durationMs: 1 },
        { id: 'b', label: 'B', status: 'cached' },
        { id: 'c', label: 'C', status: 'skipped', reason: 'not-reached' },
        { id: 'd', label: 'D', status: 'cancelled' },
        { id: 'e', label: 'E', status: 'failed', error: 'nope' },
      ]),
    ).toMatchObject({ done: 5, total: 5 });
  });

  it('leaves planned and running calls outstanding', () => {
    expect(
      workflowCallTally([
        { id: 'a', label: 'A', status: 'completed', durationMs: 1 },
        { id: 'b', label: 'B', status: 'running' },
        { id: 'c', label: 'C', status: 'planned' },
      ]),
    ).toMatchObject({ done: 1, total: 3, running: 1 });
  });

  it('leaves a user skip without an explanatory clause', () => {
    expect(
      formatWorkflowCallLine({
        id: 'review',
        label: 'Stopped review',
        status: 'skipped',
        reason: 'user',
        model: 'kimiK2',
        durationMs: 7_320,
        totalCostUsd: 0.04,
      }),
    ).toBe('Skipped: Stopped review · kimiK2 · 7s · $0.040');
  });
});
