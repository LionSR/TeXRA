// Third-party imports
import { beforeAll, describe, expect, it } from 'vitest';

// Local imports - test utilities
import { useLitComponentTestDom } from '../settings/litComponentTestUtils';

useLitComponentTestDom(
  () => import('@progressView/frontend/components/TerminalOutput'),
);

// Loaded after useLitComponentTestDom's beforeAll installs the jsdom globals
// this module touches at import time.
let planTerminalTextUpdate: typeof import('@progressView/frontend/components/TerminalOutput').planTerminalTextUpdate;
let countTerminalRows: typeof import('@progressView/frontend/components/TerminalOutput').countTerminalRows;
let nextTerminalRowCount: typeof import('@progressView/frontend/components/TerminalOutput').nextTerminalRowCount;

beforeAll(async () => {
  ({ planTerminalTextUpdate, countTerminalRows, nextTerminalRowCount } =
    await import('@progressView/frontend/components/TerminalOutput'));
});

describe('terminal-output text update planning', () => {
  it('writes only the appended suffix when output grows', () => {
    expect(planTerminalTextUpdate('alpha\n', 'alpha\nbeta\n')).toEqual({
      reset: false,
      textToWrite: 'beta\n',
    });
  });

  it('falls back to a reset when retained output is replaced', () => {
    expect(planTerminalTextUpdate('alpha\nbeta\n', 'beta\n')).toEqual({
      reset: true,
      textToWrite: 'beta\n',
    });
  });

  it('counts terminal rows without allocating split arrays', () => {
    expect(countTerminalRows('')).toBe(1);
    expect(countTerminalRows('one')).toBe(1);
    expect(countTerminalRows('one\ntwo\n')).toBe(3);
  });

  it('updates row count incrementally for appended output', () => {
    const updatePlan = planTerminalTextUpdate('alpha\n', 'alpha\nbeta\ngamma');

    expect(nextTerminalRowCount(2, updatePlan)).toBe(3);
  });

  it('recounts rows when output is reset after trimming', () => {
    const updatePlan = planTerminalTextUpdate('alpha\nbeta\n', 'beta\ngamma\n');

    expect(nextTerminalRowCount(3, updatePlan)).toBe(3);
  });
});
