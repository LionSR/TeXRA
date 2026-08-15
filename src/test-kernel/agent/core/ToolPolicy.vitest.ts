import { describe, expect, it } from 'vitest';

import { createToolPolicy } from '@agent/core/flows/BaseFlowServices';

describe('createToolPolicy', () => {
  it('freezes the policy and its runtimeUnavailableTools array', () => {
    const policy = createToolPolicy({
      approvalPromptsUnavailable: true,
      runtimeUnavailableTools: ['inquiry', 'bash'],
      stopAfterCycle: true,
    });

    expect(Object.isFrozen(policy)).toBe(true);
    expect(Object.isFrozen(policy.runtimeUnavailableTools)).toBe(true);
  });

  it('copies runtimeUnavailableTools so later source mutation cannot leak in', () => {
    const source = ['inquiry'];
    const policy = createToolPolicy({ runtimeUnavailableTools: source });

    source.push('bash');

    expect(policy.runtimeUnavailableTools).toEqual(['inquiry']);
    // The policy holds its own frozen copy, not the caller's array.
    expect(policy.runtimeUnavailableTools).not.toBe(source);
  });

  it('defaults to an empty frozen policy', () => {
    const policy = createToolPolicy();

    expect(Object.isFrozen(policy)).toBe(true);
    expect(policy.runtimeUnavailableTools).toBeUndefined();
    expect(policy.approvalPromptsUnavailable).toBeUndefined();
    expect(policy.stopAfterCycle).toBeUndefined();
  });
});
