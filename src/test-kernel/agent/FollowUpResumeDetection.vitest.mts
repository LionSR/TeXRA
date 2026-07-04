import { describe, expect, it } from 'vitest';

import { shouldProbePersistedFlowForFollowUp } from '@agent/runtime/followUpResumeDetection';
import { STREAM_PHASE } from '@shared/schemas';

describe('shouldProbePersistedFlowForFollowUp', () => {
  it.each([
    { label: 'no in-memory status is available', status: undefined },
    {
      label: 'a terminal failed phase may still have a persisted flow record',
      status: STREAM_PHASE.FAILED,
    },
    {
      label:
        'a terminal cancelled phase may still have a persisted flow record',
      status: STREAM_PHASE.CANCELLED,
    },
    {
      label:
        'a terminal completed phase may still have a persisted flow record',
      status: STREAM_PHASE.COMPLETED,
    },
  ])('probes when $label', ({ status }) => {
    expect(shouldProbePersistedFlowForFollowUp(status)).toBe(true);
  });

  it.each([
    { label: 'the active running phase', status: STREAM_PHASE.RUNNING },
    { label: 'the already waiting phase', status: STREAM_PHASE.WAITING },
  ])('does not probe $label', ({ status }) => {
    expect(shouldProbePersistedFlowForFollowUp(status)).toBe(false);
  });
});
