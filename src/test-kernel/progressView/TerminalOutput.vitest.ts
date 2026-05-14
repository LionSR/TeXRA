// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - test utilities
import { useLitComponentTestDom } from '../settings/litComponentTestUtils';

useLitComponentTestDom(
  () => import('@progressView/frontend/components/TerminalOutput'),
);

describe('terminal-output text update planning', () => {
  it('writes only the appended suffix when output grows', async () => {
    const { planTerminalTextUpdate } =
      await import('@progressView/frontend/components/TerminalOutput');

    expect(planTerminalTextUpdate('alpha\n', 'alpha\nbeta\n')).toEqual({
      reset: false,
      textToWrite: 'beta\n',
    });
  });

  it('falls back to a reset when retained output is replaced', async () => {
    const { planTerminalTextUpdate } =
      await import('@progressView/frontend/components/TerminalOutput');

    expect(planTerminalTextUpdate('alpha\nbeta\n', 'beta\n')).toEqual({
      reset: true,
      textToWrite: 'beta\n',
    });
  });

  it('counts terminal rows without allocating split arrays', async () => {
    const { countTerminalRows } =
      await import('@progressView/frontend/components/TerminalOutput');

    expect(countTerminalRows('')).toBe(1);
    expect(countTerminalRows('one')).toBe(1);
    expect(countTerminalRows('one\ntwo\n')).toBe(3);
  });
});
