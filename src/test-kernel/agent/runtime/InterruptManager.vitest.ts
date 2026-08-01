// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports
import { createInterruptCallbacks } from '@agent/runtime/InterruptManager';

describe('createInterruptCallbacks', () => {
  it('reports a live run as not interrupted', () => {
    const callbacks = createInterruptCallbacks();

    expect(callbacks.abortSignal.aborted).toBe(false);
    expect(callbacks.checkInterruption()).toBe(false);
  });

  it('aborts the run signal, and reports it through checkInterruption', () => {
    const callbacks = createInterruptCallbacks();

    callbacks.onInterrupt?.();

    expect(callbacks.abortSignal.aborted).toBe(true);
    expect(callbacks.checkInterruption()).toBe(true);
  });

  it('delivers the interrupt to work that only starts afterwards', () => {
    const callbacks = createInterruptCallbacks();

    // Nodes used to register and release their own controllers, so an
    // interrupt could land while no controller was registered. The run signal
    // has no such gap: work starting later reads it already aborted.
    callbacks.onInterrupt?.();

    expect(callbacks.abortSignal.aborted).toBe(true);
    expect(AbortSignal.any([callbacks.abortSignal]).aborted).toBe(true);
  });

  it('stays interrupted when the user interrupts again', () => {
    const callbacks = createInterruptCallbacks();

    callbacks.onInterrupt?.();
    callbacks.onInterrupt?.();

    expect(callbacks.abortSignal.aborted).toBe(true);
    expect(callbacks.checkInterruption()).toBe(true);
  });
});
