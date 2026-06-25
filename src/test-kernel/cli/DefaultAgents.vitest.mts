import { describe, expect, it } from 'vitest';

import {
  BUILTIN_DEFAULT_CHAT_AGENT,
  implicitDefaultToolUseAgents,
  resolveImplicitToolUseAgentDefault,
} from '@cli/runtime/defaultAgents';

describe('CLI implicit default agent policy', () => {
  it('keeps research as the built-in default chat agent', () => {
    expect(BUILTIN_DEFAULT_CHAT_AGENT).toBe('research');
  });

  it('filters implicit default candidates without mutating explicit options', () => {
    const candidates = [
      { name: 'simplifier', source: 'built-in' },
      { name: 'builtInToolUse:simplifier', source: 'built-in' },
      { name: 'SIMPLIFIER', source: 'built-in' },
      { name: 'assistant', source: 'built-in' },
      { name: 'review', source: 'built-in' },
    ] as const;

    expect(implicitDefaultToolUseAgents(candidates)).toEqual([
      { name: 'assistant', source: 'built-in' },
      { name: 'review', source: 'built-in' },
    ]);
  });

  it('normalizes only allowed implicit default values', () => {
    expect(resolveImplicitToolUseAgentDefault(' review ')).toBe('review');
    expect(resolveImplicitToolUseAgentDefault('simplifier')).toBeUndefined();
    expect(resolveImplicitToolUseAgentDefault('SIMPLIFIER')).toBeUndefined();
    expect(
      resolveImplicitToolUseAgentDefault('builtInToolUse:simplifier'),
    ).toBeUndefined();
    expect(resolveImplicitToolUseAgentDefault('   ')).toBeUndefined();
    expect(resolveImplicitToolUseAgentDefault(undefined)).toBeUndefined();
  });
});
