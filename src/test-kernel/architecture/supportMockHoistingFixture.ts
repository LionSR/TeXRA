// Third-party imports
import { vi } from 'vitest';

const supportMockHoistingBag = vi.hoisted(() => {
  const order: string[] = ['hoisted-factory'];
  return { order, value: 1 };
});

supportMockHoistingBag.order.push('before');
supportMockHoistingBag.order.push('after');

export function supportMockHoistingValue(): number {
  return supportMockHoistingBag.value;
}

export function supportMockHoistingOrder(): readonly string[] {
  return supportMockHoistingBag.order;
}
