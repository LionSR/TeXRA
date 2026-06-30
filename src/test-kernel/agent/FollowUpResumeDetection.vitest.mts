import { describe, expect, it } from 'vitest';

import { shouldProbePersistedFlowForFollowUp } from '@agent/runtime/followUpResumeDetection';
import { STREAM_STATUS } from '@shared/schemas';

describe('shouldProbePersistedFlowForFollowUp', () => {
  it.each([
    { label: 'no in-memory status is available', status: undefined },
    {
      label: 'a terminal error status may still have a persisted flow record',
      status: STREAM_STATUS.ERROR,
    },
    {
      label: 'a terminal stopped status may still have a persisted flow record',
      status: STREAM_STATUS.STOPPED,
    },
  ])('probes when $label', ({ status }) => {
    expect(shouldProbePersistedFlowForFollowUp(status)).toBe(true);
  });

  it.each([
    { label: 'the explicit ready status', status: STREAM_STATUS.READY },
    {
      label: 'the active initializing status',
      status: STREAM_STATUS.INITIALIZING,
    },
    { label: 'the active running status', status: STREAM_STATUS.RUNNING },
    { label: 'the active resuming status', status: STREAM_STATUS.RESUMING },
    { label: 'the already waiting status', status: STREAM_STATUS.WAITING },
  ])('does not probe $label', ({ status }) => {
    expect(shouldProbePersistedFlowForFollowUp(status)).toBe(false);
  });
});
