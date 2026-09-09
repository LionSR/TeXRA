import { describe, expect, it } from 'vitest';

import { ToolInjectionRegistry } from '@agent/runtime/toolInjection';

describe('tool-injection registry', () => {
  it('rejects duplicate `toolName` registrations', () => {
    const registry = new ToolInjectionRegistry();
    registry.register({ toolName: 'memory', shouldInject: () => true });
    expect(() =>
      registry.register({ toolName: 'memory', shouldInject: () => false }),
    ).toThrow(/Duplicate conditional tool injection/);
  });
});
