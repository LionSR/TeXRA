import { describe, expect, it } from 'vitest';

import { ToolInjectionRegistry } from '@agent/runtime/toolInjection';

describe('tool-injection registry', () => {
  it('registers injections and returns them in insertion order', () => {
    const registry = new ToolInjectionRegistry();
    registry.register({ toolName: 'memory', shouldInject: () => true });
    registry.register({ toolName: 'plan', shouldInject: () => false });

    const names = registry.list().map((i) => i.toolName);
    expect(names).toEqual(['memory', 'plan']);
  });

  it('rejects duplicate `toolName` registrations', () => {
    const registry = new ToolInjectionRegistry();
    registry.register({ toolName: 'memory', shouldInject: () => true });
    expect(() =>
      registry.register({ toolName: 'memory', shouldInject: () => false }),
    ).toThrow(/Duplicate conditional tool injection/);
  });

  it('predicates are re-evaluated on each call (not captured at registration)', () => {
    const registry = new ToolInjectionRegistry();
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
    const registry = new ToolInjectionRegistry();
    const other = new ToolInjectionRegistry();
    const injection = {
      toolName: 'memory',
      shouldInject: () => true,
    } as const;

    registry.register(injection);

    expect(registry.list()).toEqual([injection]);
    expect(other.list()).toEqual([]);
  });
});
