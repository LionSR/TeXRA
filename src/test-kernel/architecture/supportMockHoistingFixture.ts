// Third-party imports
import { vi } from 'vitest';

interface HoistingProbeGlobal {
  __texraSupportMockHoistingOrder?: string[];
}

function probeOrder(): string[] {
  const global = globalThis as HoistingProbeGlobal;
  return (global.__texraSupportMockHoistingOrder ??= []);
}

probeOrder().push('before');

const supportMockHoistingBag = vi.hoisted(() => {
  probeOrder().push('hoisted-factory');
  return { value: 1 };
});

probeOrder().push('after');

export function supportMockHoistingValue(): number {
  return supportMockHoistingBag.value;
}

export function supportMockHoistingOrder(): readonly string[] {
  return probeOrder();
}
