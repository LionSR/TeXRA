import { describe, expect, it } from 'vitest';

import {
  formatWorkflowCallMetadataParts,
  formatWorkflowCallLine,
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
