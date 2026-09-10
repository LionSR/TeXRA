import { describe, expect, it } from 'vitest';

import {
  type CompileFailure,
  type OutputFileInfo,
  type RunId,
} from '@shared/schemas';
import {
  formatWorkflowRunContext,
  type WorkflowRunContextInput,
} from '@shared/copy/workflowRunContext';

type RunFields = WorkflowRunContextInput['stream'];

function baseStream(overrides: Partial<RunFields> = {}): RunFields {
  return {
    // The resolved identity display name — a producer never ships an
    // arbitrary label beside a resolved identity.
    label: 'writer',
    model: 'gemini31p',
    modelLabel: 'Gemini 3.1 Pro',
    runId: 'a1b2c3d4',
    ...overrides,
  };
}

function output(overrides: Partial<OutputFileInfo> = {}): OutputFileInfo {
  return {
    source: 'main.tex',
    round: 2,
    lineage: null,
    diff: null,
    location: {
      kind: 'runStorage',
      absolutePath: '/tmp/exec/answer.tex',
      relativePath: 'answer.tex',
      runId: 'a1b2c3d4' as RunId,
    },
    ...overrides,
  };
}

function compileFailure(
  overrides: Partial<CompileFailure> = {},
): CompileFailure {
  return {
    round: 2,
    displayName: 'answer.tex',
    output: {
      kind: 'runStorage',
      absolutePath: '/tmp/exec/answer.tex',
      relativePath: 'answer.tex',
      runId: 'a1b2c3d4' as RunId,
    },
    log: {
      kind: 'runStorage',
      absolutePath: '/tmp/exec/answer.log',
      relativePath: 'answer.log',
      runId: 'a1b2c3d4' as RunId,
    },
    logRelativePath: 'answer.log',
    ...overrides,
  };
}

describe('formatWorkflowRunContext', () => {
  it('addresses run-storage outputs the way an agent reads them', () => {
    const text = formatWorkflowRunContext({
      stream: baseStream({ description: 'Rewrite the introduction' }),
      files: { 2: [output()] },
      compileFailures: {},
    });

    expect(text).toBe(
      [
        'Workflow run: writer (Gemini 3.1 Pro)',
        'Run: a1b2c3d4',
        'Goal: Rewrite the introduction',
        '',
        'Outputs:',
        '- r3: /executions/a1b2c3d4/files/answer.tex (source: main.tex)',
      ].join('\n'),
    );
  });

  it('renders workspace outputs relative and external outputs absolute', () => {
    const text = formatWorkflowRunContext({
      stream: baseStream(),
      files: {
        1: [
          output({
            source: '',
            round: 1,
            location: {
              kind: 'workspace',
              absolutePath: '/repo/chapter.tex',
              relativePath: 'chapter.tex',
            },
          }),
          output({
            source: '',
            round: 1,
            location: {
              kind: 'external',
              absolutePath: '/elsewhere/appendix.tex',
            },
          }),
        ],
      },
      compileFailures: {},
    });

    // A blank source drops the parenthetical rather than printing "()".
    expect(text).toContain('- r2: chapter.tex\n');
    expect(text).toContain('- r2: /elsewhere/appendix.tex');
    expect(text).not.toContain('(source: )');
  });

  it('orders rounds numerically rather than by key string', () => {
    const text = formatWorkflowRunContext({
      stream: baseStream(),
      files: {
        10: [
          output({
            round: 10,
            location: {
              kind: 'workspace',
              absolutePath: '/repo/tenth.tex',
              relativePath: 'tenth.tex',
            },
          }),
        ],
        2: [output()],
      },
      compileFailures: {},
    });

    expect(text.indexOf('- r3:')).toBeLessThan(text.indexOf('- r11:'));
  });

  it('lists compile failures with their log paths', () => {
    const text = formatWorkflowRunContext({
      stream: baseStream(),
      files: { 2: [output()] },
      compileFailures: { 2: [compileFailure()] },
    });

    expect(text).toContain(
      '- r3 answer.tex: log /executions/a1b2c3d4/files/answer.log',
    );
  });

  it('copies a failed run that produced no outputs', () => {
    const text = formatWorkflowRunContext({
      stream: baseStream(),
      files: {},
      compileFailures: { 2: [compileFailure()] },
    });

    expect(text).not.toContain('Outputs:');
    expect(text).toContain('Compile failures:');
  });

  it('omits the run and goal lines when the stream has neither', () => {
    const text = formatWorkflowRunContext({
      stream: baseStream({ runId: undefined, description: undefined }),
      files: { 2: [output()] },
      compileFailures: {},
    });

    expect(text).not.toContain('Run:');
    expect(text).not.toContain('Goal:');
    expect(text.startsWith('Workflow run: writer (Gemini 3.1 Pro)')).toBe(true);
  });

  it('drops the model parenthetical when the run has no model', () => {
    const text = formatWorkflowRunContext({
      stream: baseStream({ model: undefined, modelLabel: undefined }),
      files: { 2: [output()] },
      compileFailures: {},
    });

    expect(text.startsWith('Workflow run: writer\n')).toBe(true);
  });

  it('returns empty when the run has no outputs and no failures', () => {
    expect(
      formatWorkflowRunContext({
        stream: baseStream(),
        files: {},
        compileFailures: {},
      }),
    ).toBe('');

    // An empty per-round bucket is still nothing to copy.
    expect(
      formatWorkflowRunContext({
        stream: baseStream(),
        files: { 2: [] },
        compileFailures: {},
      }),
    ).toBe('');
  });
});
