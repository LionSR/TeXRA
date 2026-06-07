import { beforeEach, describe, expect, it } from 'vitest';

import {
  ToolInjectionRegistry,
  type ConditionalToolInjection,
} from '@agent/runtime/toolInjection';

describe('tool-injection registry', () => {
  let registry: ToolInjectionRegistry;

  beforeEach(() => {
    registry = new ToolInjectionRegistry();
  });

  it('registers injections and returns them in insertion order', () => {
    registry.register({ toolName: 'memory', shouldInject: () => true });
    registry.register({ toolName: 'plan', shouldInject: () => false });

    const names = registry.list().map((i) => i.toolName);
    expect(names).toEqual(['memory', 'plan']);
  });

  it('rejects duplicate `toolName` registrations', () => {
    registry.register({ toolName: 'memory', shouldInject: () => true });
    expect(() =>
      registry.register({ toolName: 'memory', shouldInject: () => false }),
    ).toThrow(/Duplicate conditional tool injection/);
  });

  it('predicates are re-evaluated on each call (not captured at registration)', () => {
    let enabled = false;
    registry.register({
      toolName: 'memory',
      shouldInject: () => enabled,
    });
    const [injection] = registry.list();
    expect(injection.shouldInject()).toBe(false);
    enabled = true;
    expect(injection.shouldInject()).toBe(true);
  });

  it('keeps injections scoped to each registry instance', () => {
    const other = new ToolInjectionRegistry();
    const injection: ConditionalToolInjection = {
      toolName: 'memory',
      shouldInject: () => true,
    };

    registry.register(injection);

    expect(registry.list()).toEqual([injection]);
    expect(other.list()).toEqual([]);
  });
});
