import { describe, expect, it } from 'vitest';

import {
  formatWorkflowTaskMetadataParts,
  formatWorkflowTaskLine,
  workflowPhaseTaskProgress,
} from '@shared/copy/workflowTask';

describe('workflow task copy', () => {
  it('uses one terminal metadata representation across hosts', () => {
    expect(
      formatWorkflowTaskMetadataParts({
        id: 'draft',
        label: 'Draft',
        status: 'completed',
        model: 'gpt56',
        durationMs: 7_320,
        totalCostUsd: 0.04,
      }),
    ).toEqual(['gpt56', '7s', '$0.040 total']);
  });

  it('does not attach terminal metadata to an active task', () => {
    expect(
      formatWorkflowTaskMetadataParts({
        id: 'draft',
        label: 'Draft',
        status: 'running',
      }),
    ).toEqual([]);
  });

  it('uses one failed-task line across textual hosts', () => {
    expect(
      formatWorkflowTaskLine({
        id: 'audit',
        label: 'Audit source',
        status: 'failed',
        error: 'Runner stopped.',
        model: 'kimiK2',
        durationMs: 7_320,
        totalCostUsd: 0.04,
      }),
    ).toBe(
      'Failed: Audit source · kimiK2 · 7s · $0.040 total — Runner stopped.',
    );
  });

  it('explains a task the run never reached on every textual host', () => {
    expect(
      formatWorkflowTaskLine({
        id: 'audit',
        label: 'Audit later',
        status: 'skipped',
        reason: 'not-reached',
      }),
    ).toBe(
      'Skipped: Audit later — The workflow ended before this task was reached.',
    );
  });

  it('counts an empty phase as no work rather than complete', () => {
    expect(workflowPhaseTaskProgress([])).toEqual({ done: 0, total: 0 });
  });

  it('counts every terminal status as done, not just completions', () => {
    expect(
      workflowPhaseTaskProgress([
        { id: 'a', label: 'A', status: 'completed', durationMs: 1 },
        { id: 'b', label: 'B', status: 'cached' },
        { id: 'c', label: 'C', status: 'skipped', reason: 'not-reached' },
        { id: 'd', label: 'D', status: 'failed', error: 'nope' },
      ]),
    ).toEqual({ done: 4, total: 4 });
  });

  it('leaves planned and running tasks outstanding', () => {
    expect(
      workflowPhaseTaskProgress([
        { id: 'a', label: 'A', status: 'completed', durationMs: 1 },
        { id: 'b', label: 'B', status: 'running' },
        { id: 'c', label: 'C', status: 'planned' },
      ]),
    ).toEqual({ done: 1, total: 3 });
  });

  it('leaves a user skip without an explanatory clause', () => {
    expect(
      formatWorkflowTaskLine({
        id: 'review',
        label: 'Stopped review',
        status: 'skipped',
        reason: 'user',
        model: 'kimiK2',
        durationMs: 7_320,
        totalCostUsd: 0.04,
      }),
    ).toBe('Skipped: Stopped review · kimiK2 · 7s · $0.040 total');
  });
});
