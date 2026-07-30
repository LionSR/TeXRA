// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports
import { createInterruptCallbacks } from '@agent/runtime/InterruptManager';

describe('createInterruptCallbacks', () => {
  it('aborts the controller registered while the run is live', () => {
    const callbacks = createInterruptCallbacks();
    const controller = new AbortController();

    callbacks.setAbortController(controller);
    callbacks.onInterrupt?.();

    expect(controller.signal.aborted).toBe(true);
    expect(callbacks.checkInterruption()).toBe(true);
  });

  it('aborts the next controller when the interrupt landed on an empty slot', () => {
    const callbacks = createInterruptCallbacks();

    // Nodes null the slot in their `finally`, so the interrupt can arrive
    // between one node releasing it and the next registering.
    callbacks.setAbortController(null);
    callbacks.onInterrupt?.();

    const controller = new AbortController();
    callbacks.setAbortController(controller);

    expect(controller.signal.aborted).toBe(true);
  });

  it('still reaches a controller registered after a second interrupt', () => {
    const callbacks = createInterruptCallbacks();

    const first = new AbortController();
    callbacks.setAbortController(first);
    callbacks.onInterrupt?.();
    callbacks.setAbortController(null);

    const second = new AbortController();
    callbacks.onInterrupt?.();
    callbacks.setAbortController(second);

    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(true);
  });

  it('aborts a controller registered after the latch without a further interrupt', () => {
    const callbacks = createInterruptCallbacks();
    callbacks.onInterrupt?.();

    const first = new AbortController();
    callbacks.setAbortController(first);
    callbacks.setAbortController(null);
    const second = new AbortController();
    callbacks.setAbortController(second);

    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(true);
  });
});
