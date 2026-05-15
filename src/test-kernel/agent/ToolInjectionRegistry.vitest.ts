import { beforeEach, describe, expect, it } from 'vitest';

import {
  __resetToolInjectionRegistry,
  listToolInjections,
  registerToolInjection,
} from '@agent/runtime/toolInjection';

describe('tool-injection registry', () => {
  beforeEach(() => {
    __resetToolInjectionRegistry();
  });

  it('registers injections and returns them in insertion order', () => {
    registerToolInjection({ toolName: 'memory', shouldInject: () => true });
    registerToolInjection({ toolName: 'odyssey', shouldInject: () => false });

    const names = listToolInjections().map((i) => i.toolName);
    expect(names).toEqual(['memory', 'odyssey']);
  });

  it('rejects duplicate `toolName` registrations', () => {
    registerToolInjection({ toolName: 'memory', shouldInject: () => true });
    expect(() =>
      registerToolInjection({ toolName: 'memory', shouldInject: () => false }),
    ).toThrow(/Duplicate conditional tool injection/);
  });

  it('predicates are re-evaluated on each call (not captured at registration)', () => {
    let enabled = false;
    registerToolInjection({
      toolName: 'memory',
      shouldInject: () => enabled,
    });
    const [injection] = listToolInjections();
    expect(injection.shouldInject()).toBe(false);
    enabled = true;
    expect(injection.shouldInject()).toBe(true);
  });
});
