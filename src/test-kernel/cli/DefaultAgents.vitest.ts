import { describe, expect, it } from 'vitest';

import {
  BUILTIN_DEFAULT_CHAT_AGENT,
  pickDefaultToolUseAgent,
} from '@cli/runtime/defaultAgents';
import {
  implicitDefaultToolUseAgents,
  isImplicitDefaultEligible,
} from '@shared/constants/agents';

describe('CLI implicit default agent policy', () => {
  it('uses assistant as the built-in default chat agent', () => {
    expect(BUILTIN_DEFAULT_CHAT_AGENT).toBe('assistant');
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

  it.each([
    { name: 'review', eligible: true },
    { name: ' review ', eligible: true },
    { name: 'simplifier', eligible: false },
    { name: 'SIMPLIFIER', eligible: false },
    { name: 'builtInToolUse:simplifier', eligible: false },
  ])(
    'recognizes "$name" as implicit-default-eligible: $eligible',
    ({ name, eligible }) => {
      expect(isImplicitDefaultEligible(name)).toBe(eligible);
    },
  );

  it('selects the built-in default only when it is visible', () => {
    expect(
      pickDefaultToolUseAgent([{ name: 'research' }, { name: 'review' }]),
    ).toBe('research');
    expect(
      pickDefaultToolUseAgent([{ name: 'research' }, { name: 'assistant' }]),
    ).toBe('assistant');
    expect(pickDefaultToolUseAgent([])).toBe('assistant');
  });

  it('prefers the team lead order over registry file order when scoped', () => {
    // A scoped roster that hides `assistant`: pick the lead by
    // PREFERRED_TOOL_USE_AGENTS order (engineer) rather than whichever agent
    // sorts first in the registry's file order (codeReviewer).
    expect(
      pickDefaultToolUseAgent([
        { name: 'codeReviewer' },
        { name: 'engineer' },
        { name: 'coder' },
      ]),
    ).toBe('engineer');
    // No preferred agent present → fall back to the first visible candidate.
    expect(
      pickDefaultToolUseAgent([{ name: 'codeReviewer' }, { name: 'coder' }]),
    ).toBe('codeReviewer');
  });
});
