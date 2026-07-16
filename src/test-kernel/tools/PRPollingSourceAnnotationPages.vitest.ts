// Suites for the annotation-page budget path of @tools/github
// (PRPollingSource pagination + AnnotationFetchBudget token bucket).

import { afterEach, describe, expect, it, type Mock, vi } from 'vitest';
import type { GhCheckAnnotation, GhCheckRun } from '@tools/github/prTypes';
import { AnnotationFetchBudget } from '@tools/github/annotationFetchBudget';
import { mockGitHubClient } from '../support/githubClientMock';

// ---------------------------------------------------------------------------
// PRPollingSourceAnnotationPages
// ---------------------------------------------------------------------------

interface AnnotationFetchSource {
  fetchAnnotations(
    owner: string,
    repo: string,
    checkRunId: number,
    now?: number,
  ): Promise<GhCheckAnnotation[]>;
}

interface CurrentShaState {
  pendingAnnotationRuns: GhCheckRun[];
}

interface AnnotationDrainState {
  pr: { owner: string; repo: string; pullNumber: number };
  slug: string;
  listeners: Set<(text: string) => void>;
  annotationLevelByListener: Map<(text: string) => void, 'failure'>;
  currentShaState: CurrentShaState | undefined;
  lastSuccessAt: number;
  consecutiveFailures: number;
  skipPollUntilMs: number;
}

interface AnnotationDrainSource extends AnnotationFetchSource {
  drainAnnotationQueues(
    entries: ReadonlyArray<readonly [string, AnnotationDrainState]>,
    now?: number,
  ): Promise<void>;
  has(key: string): boolean;
}

interface PRPollingSourceClass {
  new (): AnnotationDrainSource;
  resetAnnotationFetchBudgetForTests(
    remainingRequests?: number,
    nowMs?: number,
  ): void;
}

function annotation(
  level: GhCheckAnnotation['annotation_level'],
  index: number,
): GhCheckAnnotation {
  return {
    path: 'blueprint/src/chapter.tex',
    start_line: index + 1,
    end_line: index + 1,
    annotation_level: level,
    message: `${level} ${index}`,
  };
}

async function createHarness(): Promise<{
  ghGet: Mock;
  source: AnnotationFetchSource;
  PRPollingSource: PRPollingSourceClass;
}> {
  vi.resetModules();
  const ghGet = vi.fn();
  mockGitHubClient(ghGet);
  const { PRPollingSource } = await import('@tools/github/PRPollingSource');
  return {
    ghGet,
    source: new PRPollingSource() as unknown as AnnotationFetchSource,
    PRPollingSource: PRPollingSource as unknown as PRPollingSourceClass,
  };
}

function checkRun(id: number): GhCheckRun {
  return {
    id,
    name: 'lint',
    status: 'completed',
    conclusion: 'success',
    html_url: `https://example.test/checks/${id}`,
    completed_at: '2026-05-12T00:00:00Z',
    output: { annotations_count: 1 },
  };
}

function drainState(runs: GhCheckRun[]): AnnotationDrainState {
  return {
    pr: { owner: 'owner', repo: 'repo', pullNumber: 7 },
    slug: 'owner/repo',
    listeners: new Set(),
    annotationLevelByListener: new Map(),
    currentShaState: { pendingAnnotationRuns: runs },
    lastSuccessAt: Date.now(),
    consecutiveFailures: 0,
    skipPollUntilMs: 0,
  };
}

describe('PRPollingSource annotation pagination', () => {
  afterEach(() => {
    vi.doUnmock('@tools/github/githubClient');
    vi.resetModules();
  });

  it('fetches later annotation pages before level filtering runs', async () => {
    const { ghGet, source } = await createHarness();
    const firstPage = Array.from({ length: 100 }, (_, index) =>
      annotation('warning', index),
    );
    const secondPage = [annotation('failure', 100)];
    ghGet
      .mockResolvedValueOnce({ status: 200, data: firstPage })
      .mockResolvedValueOnce({ status: 200, data: secondPage });

    const annotations = await source.fetchAnnotations('owner', 'repo', 42);

    expect(annotations).toHaveLength(101);
    expect(annotations.at(-1)?.annotation_level).toBe('failure');
    expect(ghGet).toHaveBeenCalledTimes(2);
    expect(ghGet.mock.calls.map((call) => call[0])).toEqual([
      '/repos/owner/repo/check-runs/42/annotations?per_page=100&page=1',
      '/repos/owner/repo/check-runs/42/annotations?per_page=100&page=2',
    ]);
  });

  it('caps annotation pagination for malformed full pages', async () => {
    const { ghGet, source } = await createHarness();
    const fullPage = Array.from({ length: 100 }, (_, index) =>
      annotation('warning', index),
    );
    ghGet.mockResolvedValue({ status: 200, data: fullPage });

    const annotations = await source.fetchAnnotations('owner', 'repo', 42);

    expect(annotations).toHaveLength(5000);
    expect(ghGet).toHaveBeenCalledTimes(50);
    expect(ghGet.mock.calls.at(-1)?.[0]).toBe(
      '/repos/owner/repo/check-runs/42/annotations?per_page=100&page=50',
    );
  });

  it('counts annotation budget by endpoint page', async () => {
    const { ghGet, source, PRPollingSource } = await createHarness();
    PRPollingSource.resetAnnotationFetchBudgetForTests(1);
    const fullPage = Array.from({ length: 100 }, (_, index) =>
      annotation('warning', index),
    );
    ghGet.mockResolvedValue({ status: 200, data: fullPage });

    await expect(source.fetchAnnotations('owner', 'repo', 42)).rejects.toThrow(
      'Annotation fetch budget exhausted',
    );

    expect(ghGet).toHaveBeenCalledTimes(1);
  });

  it('leaves queued annotation runs in place when the page budget is exhausted', async () => {
    const { ghGet, PRPollingSource } = await createHarness();
    const source = new PRPollingSource();
    source.has = vi.fn().mockReturnValue(true);
    PRPollingSource.resetAnnotationFetchBudgetForTests(0);
    const runs = [checkRun(7), checkRun(8)];
    const state = drainState(runs);

    await source.drainAnnotationQueues([['owner/repo#7', state]]);

    expect(ghGet).not.toHaveBeenCalled();
    expect(state.currentShaState?.pendingAnnotationRuns).toEqual(runs);
  });
});

// ---------------------------------------------------------------------------
// AnnotationFetchBudget
// ---------------------------------------------------------------------------

describe('AnnotationFetchBudget', () => {
  it('does not stall refills after the clock moves backward', () => {
    const budget = new AnnotationFetchBudget(1, 1000);

    expect(budget.tryClaim(1000)).toBe(true);
    expect(budget.tryClaim(900)).toBe(false);
    expect(budget.tryClaim(1900)).toBe(true);
  });
});
