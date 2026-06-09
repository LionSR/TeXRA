// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports
import {
  SUBAGENT_DELIVERY_DECISION,
  SubagentDeliveryRegistry,
  SubagentDeliveryState,
} from '@tools/subagentDeliveryState';

describe('subagent delivery state', () => {
  it('keeps an already delivered wait cycle marked delivered', () => {
    const state = new SubagentDeliveryState();
    expect(state.markDelivered()).toBe(true);
    expect(state.markDelivered()).toBe(false);

    expect(state.resolveBeforeWaiting('child-stream')).toBe(
      SUBAGENT_DELIVERY_DECISION.AlreadyDelivered,
    );
  });

  it('does not mark a failed delivery as delivered', () => {
    const state = new SubagentDeliveryState();

    expect(state.beginDelivery()).toBe(true);
    expect(state.beginDelivery()).toBe(false);
    expect(state.resolveBeforeWaiting('child-stream')).toBe(
      SUBAGENT_DELIVERY_DECISION.AlreadyDelivered,
    );

    state.failDelivery();

    expect(state.resolveBeforeWaiting('child-stream')).toBe(
      SUBAGENT_DELIVERY_DECISION.Deliver,
    );
    expect(state.markDelivered()).toBe(true);
    expect(state.markDelivered()).toBe(false);
  });

  it('distinguishes missing child streams from deliverable cycles', () => {
    const state = new SubagentDeliveryState();

    expect(state.resolveBeforeWaiting(undefined)).toBe(
      SUBAGENT_DELIVERY_DECISION.MissingStream,
    );
    expect(state.resolveBeforeWaiting('child-stream')).toBe(
      SUBAGENT_DELIVERY_DECISION.Deliver,
    );
  });

  it('owns active delivery states by execution id', () => {
    const registry = new SubagentDeliveryRegistry();
    const state = registry.start('exec-1');

    expect(registry.getActive('exec-1')).toBe(state);
    state.markDelivered();
    expect(registry.getActive('exec-1')?.isDelivered()).toBe(true);

    registry.finish('exec-1');
    expect(registry.getActive('exec-1')).toBeUndefined();
  });
});
