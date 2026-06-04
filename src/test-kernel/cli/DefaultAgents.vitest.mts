import { describe, expect, it } from 'vitest';

import {
  BUILTIN_DEFAULT_CHAT_AGENT,
  implicitDefaultToolUseAgents,
  isImplicitDefaultToolUseAgentAllowed,
  resolveImplicitToolUseAgentDefault,
} from '@cli/runtime/defaultAgents';

describe('CLI implicit default agent policy', () => {
  it('keeps chat as the built-in default chat agent', () => {
    expect(BUILTIN_DEFAULT_CHAT_AGENT).toBe('chat');
  });

  it('does not allow simplifier to become an implicit default', () => {
    expect(isImplicitDefaultToolUseAgentAllowed('chat')).toBe(true);
    expect(isImplicitDefaultToolUseAgentAllowed(' simplifier ')).toBe(false);
    expect(isImplicitDefaultToolUseAgentAllowed('SIMPLIFIER')).toBe(false);
    expect(
      isImplicitDefaultToolUseAgentAllowed('builtInToolUse:simplifier'),
    ).toBe(false);
  });

  it('filters implicit default candidates without mutating explicit options', () => {
    const candidates = [
      { name: 'simplifier', source: 'built-in' },
      { name: 'builtInToolUse:simplifier', source: 'built-in' },
      { name: 'chat', source: 'built-in' },
      { name: 'review', source: 'built-in' },
    ] as const;

    expect(implicitDefaultToolUseAgents(candidates)).toEqual([
      { name: 'chat', source: 'built-in' },
      { name: 'review', source: 'built-in' },
    ]);
  });

  it('normalizes only allowed implicit default values', () => {
    expect(resolveImplicitToolUseAgentDefault(' review ')).toBe('review');
    expect(resolveImplicitToolUseAgentDefault('simplifier')).toBeUndefined();
    expect(resolveImplicitToolUseAgentDefault('   ')).toBeUndefined();
    expect(resolveImplicitToolUseAgentDefault(undefined)).toBeUndefined();
  });
});
