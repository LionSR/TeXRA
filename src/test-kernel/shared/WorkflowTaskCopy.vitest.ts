import { describe, expect, it } from 'vitest';

import {
  formatWorkflowTaskMetadataParts,
  formatWorkflowTaskLine,
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
});
