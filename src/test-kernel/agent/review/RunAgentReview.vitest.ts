// Third-party imports
import { beforeEach, describe, expect, it, vi } from 'vitest';

const createHelperModelKit = vi.hoisted(() => vi.fn());
const collectReviewDiff = vi.hoisted(() => vi.fn());

vi.mock('@agent/runtime/helperModel', () => ({
  createHelperModelKit,
}));

vi.mock('@agent/review/reviewDiff', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  collectReviewDiff,
}));

function mockKit(responseText: string) {
  const initializeMessages = vi.fn(async () => [{ role: 'user' }]);
  const createResponse = vi.fn(async () => ({ response: { id: 'r1' } }));
  const extractResponse = vi.fn(() => ({
    text: responseText,
    usage: {},
    stopReason: 'stop',
  }));
  createHelperModelKit.mockResolvedValue({
    kit: {
      handler: { initializeMessages, createResponse, extractResponse },
      client: { provider: 'helper' },
      modelName: 'deepseek',
    },
  });
  return { initializeMessages, createResponse, extractResponse };
}

describe('runAgentReview', () => {
  beforeEach(() => {
    vi.resetModules();
    createHelperModelKit.mockReset();
    collectReviewDiff.mockReset();
  });

  it('reviews the collected diff and keeps only issues in changed files', async () => {
    collectReviewDiff.mockResolvedValue({
      ok: true,
      value: {
        baseRef: 'abc123',
        baseDescription: 'main branch (origin/main)',
        diff: 'diff --git a/x.ts b/x.ts\n+bad line',
        changedFiles: ['x.ts', 'vendor'],
        truncated: false,
      },
    });
    const { initializeMessages, createResponse } = mockKit(
      JSON.stringify([
        {
          file: 'x.ts',
          startLine: 1,
          severity: 'critical',
          title: 'Bad line',
          description: 'd',
        },
        {
          file: 'vendor/lib.c',
          startLine: 2,
          severity: 'warning',
          title: 'Submodule issue',
          description: 'd',
        },
        {
          file: 'unrelated.ts',
          startLine: 1,
          severity: 'info',
          title: 'Hallucinated',
          description: 'd',
        },
      ]),
    );

    const { runAgentReview } = await import('@agent/review/runAgentReview');
    const outcome = await runAgentReview({
      cwd: '/repo',
      includeUntracked: true,
      includeSubmodules: true,
      approach: 'quick',
    });

    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') return;
    expect(outcome.issues.map((issue) => issue.title)).toEqual([
      'Bad line',
      'Submodule issue',
    ]);
    expect(outcome.modelName).toBe('deepseek');
    expect(outcome.baseDescription).toBe('main branch (origin/main)');
    expect(initializeMessages).toHaveBeenCalledWith(
      '',
      expect.stringContaining('+bad line'),
      undefined,
      expect.stringContaining('automated reviewer'),
    );
    expect(createResponse).toHaveBeenCalledWith(
      expect.objectContaining({ temperature: 0 }),
    );
  });

  it('returns no-changes without calling the model when the diff is empty', async () => {
    collectReviewDiff.mockResolvedValue({
      ok: true,
      value: {
        baseRef: 'abc123',
        baseDescription: 'main branch (origin/main)',
        diff: '',
        changedFiles: [],
        truncated: false,
      },
    });

    const { runAgentReview } = await import('@agent/review/runAgentReview');
    const outcome = await runAgentReview({
      cwd: '/repo',
      includeUntracked: true,
      includeSubmodules: true,
      approach: 'quick',
    });

    expect(outcome).toEqual({
      status: 'no-changes',
      baseDescription: 'main branch (origin/main)',
    });
    expect(createHelperModelKit).not.toHaveBeenCalled();
  });

  it('propagates diff collection failures as error outcomes', async () => {
    collectReviewDiff.mockResolvedValue({
      ok: false,
      reason: 'The workspace is not a git repository.',
    });

    const { runAgentReview } = await import('@agent/review/runAgentReview');
    const outcome = await runAgentReview({
      cwd: '/repo',
      includeUntracked: true,
      includeSubmodules: true,
      approach: 'quick',
    });

    expect(outcome).toEqual({
      status: 'error',
      reason: 'The workspace is not a git repository.',
    });
  });

  it('reports the helper-model unavailability reason', async () => {
    collectReviewDiff.mockResolvedValue({
      ok: true,
      value: {
        baseRef: 'abc123',
        baseDescription: 'main branch (origin/main)',
        diff: '+x',
        changedFiles: ['x.ts'],
        truncated: false,
      },
    });
    createHelperModelKit.mockResolvedValue({
      kit: undefined,
      reason: 'No API key configured for deepseek.',
    });

    const { runAgentReview } = await import('@agent/review/runAgentReview');
    const outcome = await runAgentReview({
      cwd: '/repo',
      includeUntracked: true,
      includeSubmodules: true,
      approach: 'quick',
    });

    expect(outcome).toEqual({
      status: 'error',
      reason: 'No API key configured for deepseek.',
    });
  });
});
