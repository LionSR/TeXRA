import { describe, expect, it } from 'vitest';

import { shouldProbePersistedFlowForFollowUp } from '@agent/runtime/followUpResumeDetection';
import { STREAM_STATUS } from '@shared/schemas';

describe('shouldProbePersistedFlowForFollowUp', () => {
  it('probes when no in-memory status is available', () => {
    expect(shouldProbePersistedFlowForFollowUp(undefined)).toBe(true);
  });

  it('probes terminal statuses that may still have a persisted flow record', () => {
    expect(shouldProbePersistedFlowForFollowUp(STREAM_STATUS.ERROR)).toBe(true);
    expect(shouldProbePersistedFlowForFollowUp(STREAM_STATUS.STOPPED)).toBe(
      true,
    );
  });

  it('does not probe the explicit ready status', () => {
    expect(shouldProbePersistedFlowForFollowUp(STREAM_STATUS.READY)).toBe(
      false,
    );
  });

  it('does not probe active or already waiting statuses', () => {
    expect(
      shouldProbePersistedFlowForFollowUp(STREAM_STATUS.INITIALIZING),
    ).toBe(false);
    expect(shouldProbePersistedFlowForFollowUp(STREAM_STATUS.RUNNING)).toBe(
      false,
    );
    expect(shouldProbePersistedFlowForFollowUp(STREAM_STATUS.RESUMING)).toBe(
      false,
    );
    expect(shouldProbePersistedFlowForFollowUp(STREAM_STATUS.WAITING)).toBe(
      false,
    );
  });
});
