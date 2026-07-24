import { describe, expect, it } from 'vitest';

import { formatWorkflowTaskMetadataParts } from '@shared/copy/workflowTask';

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
});
