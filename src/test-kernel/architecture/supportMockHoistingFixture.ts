// Third-party imports
import { vi } from 'vitest';

type SupportMockHoistingProbeHolder = {
  __texraSupportMockHoistingProbe?: string[];
};

function getSupportMockHoistingProbe(): string[] {
  const holder = globalThis as SupportMockHoistingProbeHolder;
  holder.__texraSupportMockHoistingProbe ??= [];
  return holder.__texraSupportMockHoistingProbe;
}

// The pre-hoisted push must sit ahead of the `vi.hoisted` call in source
// order. True hoisting runs the factory first, so the shared mutable array
// records `['hoisted-factory', 'before', 'after']`; in-place execution of
// `vi.hoisted` resets that pre-hoisted marker inside the factory and yields a
// different order, which is the regression signal
// `supportMockHoisting.vitest.ts` depends on.
getSupportMockHoistingProbe().push('before');

const supportMockHoistingBag = vi.hoisted(() => {
  const order = getSupportMockHoistingProbe();
  // Reset the shared holder at the start of every evaluation so watch-mode
  // re-runs and `vi.resetModules()` consumers still get a fresh array.
  order.length = 0;
  order.push('hoisted-factory');
  return { order, value: 1 };
});

supportMockHoistingBag.order.push('after');

export function supportMockHoistingValue(): number {
  return supportMockHoistingBag.value;
}

export function supportMockHoistingOrder(): readonly string[] {
  return supportMockHoistingBag.order;
}
