import { describe, expect, it } from 'vitest';

import {
  appendCompileFailureRoundContext,
  formatCompileFailureRoundContext,
} from '@agent/implementations/flows/reflection/output/compileFailureRoundContext';
import type { CompileFailure, CompileResult } from '@shared/schemas';

const failure: CompileFailure = {
  round: 0,
  displayName: 'main.tex',
  output: {
    kind: 'workspace',
    absolutePath: '/workspace/main.tex',
    relativePath: 'main.tex',
  },
  log: {
    kind: 'runStorage',
    absolutePath: '/run/compile/r0_main.tex.log',
    relativePath: 'compile/r0_main.tex.log',
    executionId: '00000000-0000-4000-8000-000000000001',
  },
  logRelativePath: 'compile/r0_main.tex.log',
};

const failedResult: CompileResult = {
  status: 'failed',
  round: 0,
  failures: [failure],
  logExcerpt: '! Undefined control sequence.',
};

describe('compile failure round context', () => {
  it('formats failed compile results for the next round prompt', () => {
    const context = formatCompileFailureRoundContext(failedResult);

    expect(context).toContain('previous workflow round was rejected');
    expect(context).toContain('main.tex (compile/r0_main.tex.log)');
    expect(context).toContain('! Undefined control sequence.');
  });

  it('does not format successful compile results', () => {
    expect(
      formatCompileFailureRoundContext({ status: 'ok', round: 0 }),
    ).toBeUndefined();
  });

  it('appends compile context to the existing user request', () => {
    expect(
      appendCompileFailureRoundContext('Revise the document.\n', 'log tail'),
    ).toBe('Revise the document.\n\nlog tail');
  });
});
