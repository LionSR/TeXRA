// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports
import {
  resolveSubagentBeforeWaitingDelivery,
  SUBAGENT_DELIVERY_DECISION,
} from '@tools/subagentDeliveryState';

describe('subagent delivery state', () => {
  it('keeps an already delivered wait cycle marked delivered', () => {
    expect(
      resolveSubagentBeforeWaitingDelivery(
        { hasDelivered: true },
        'child-stream',
      ),
    ).toBe(SUBAGENT_DELIVERY_DECISION.AlreadyDelivered);
  });

  it('distinguishes missing child streams from deliverable cycles', () => {
    expect(
      resolveSubagentBeforeWaitingDelivery({ hasDelivered: false }, undefined),
    ).toBe(SUBAGENT_DELIVERY_DECISION.MissingStream);
    expect(
      resolveSubagentBeforeWaitingDelivery(
        { hasDelivered: false },
        'child-stream',
      ),
    ).toBe(SUBAGENT_DELIVERY_DECISION.Deliver);
  });
});
