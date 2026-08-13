// Suites for the annotation-page budget path of @tools/github
// (PRPollingSource pagination + AnnotationFetchBudget token bucket).

import { afterEach, describe, expect, it, type Mock, vi } from 'vitest';
import type { AgentTrace } from '@agent/trace';
import type { GhCheckAnnotation, GhCheckRun } from '@tools/github/prTypes';
import type { PRSubscriptionState } from '@tools/github/PRPollingSource';
import { AnnotationFetchBudget } from '@tools/github/annotationFetchBudget';
import { mockGitHubClient } from '../support/githubClientMock';
import {
  createPRCurrentShaState,
  createPRSubscriptionState,
} from '../support/prPollingSourceState';

// ---------------------------------------------------------------------------
// PRPollingSourceAnnotationPages
// ---------------------------------------------------------------------------

interface AnnotationDrainSource {
  drainAnnotationQueues(
    entries: ReadonlyArray<readonly [string, PRSubscriptionState]>,
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

type AnnotationFetchFn = (
  owner: string,
  repo: string,
  checkRunId: number,
  logger: AgentTrace,
  budget: AnnotationFetchBudget,
  now?: number,
) => Promise<GhCheckAnnotation[]>;

/** Minimal logger for driving the infrastructure `fetchAnnotations` directly. */
function testLogger(): AgentTrace {
  return { warn: vi.fn() } as unknown as AgentTrace;
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

/** A full 100-entry warning page, which keeps pagination going. */
function fullWarningPage(): GhCheckAnnotation[] {
  return Array.from({ length: 100 }, (_, index) =>
    annotation('warning', index),
  );
}

async function createHarness(): Promise<{
  ghGet: Mock;
  fetchAnnotations: AnnotationFetchFn;
  PRPollingSource: PRPollingSourceClass;
}> {
  vi.resetModules();
  const ghGet = vi.fn();
  mockGitHubClient(ghGet);
  const { PRPollingSource } = await import('@tools/github/PRPollingSource');
  const { fetchAnnotations } = await import('@tools/github/checkRunsClient');
  return {
    ghGet,
    fetchAnnotations,
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

function drainState(runs: GhCheckRun[]): PRSubscriptionState {
  return createPRSubscriptionState({
    currentShaState: createPRCurrentShaState('abcdef1234567890', {
      pendingAnnotationRuns: runs,
    }),
  });
}

describe('PRPollingSource annotation pagination', () => {
  afterEach(() => {
    vi.doUnmock('@tools/github/githubClient');
    vi.resetModules();
  });

  it('fetches later annotation pages before level filtering runs', async () => {
    const { ghGet, fetchAnnotations } = await createHarness();
    ghGet
      .mockResolvedValueOnce({ status: 200, data: fullWarningPage() })
      .mockResolvedValueOnce({
        status: 200,
        data: [annotation('failure', 100)],
      });

    const annotations = await fetchAnnotations(
      'owner',
      'repo',
      42,
      testLogger(),
      new AnnotationFetchBudget(2, 60_000),
    );

    expect(annotations).toHaveLength(101);
    expect(annotations.at(-1)?.annotation_level).toBe('failure');
    expect(ghGet).toHaveBeenCalledTimes(2);
    expect(ghGet.mock.calls.map((call) => call[0])).toEqual([
      '/repos/owner/repo/check-runs/42/annotations?per_page=100&page=1',
      '/repos/owner/repo/check-runs/42/annotations?per_page=100&page=2',
    ]);
  });

  it('caps annotation pagination for malformed full pages', async () => {
    const { ghGet, fetchAnnotations } = await createHarness();
    ghGet.mockResolvedValue({ status: 200, data: fullWarningPage() });

    const annotations = await fetchAnnotations(
      'owner',
      'repo',
      42,
      testLogger(),
      new AnnotationFetchBudget(50, 60_000),
    );

    expect(annotations).toHaveLength(5000);
    expect(ghGet).toHaveBeenCalledTimes(50);
    expect(ghGet.mock.calls.at(-1)?.[0]).toBe(
      '/repos/owner/repo/check-runs/42/annotations?per_page=100&page=50',
    );
  });

  it('counts annotation budget by endpoint page', async () => {
    const { ghGet, fetchAnnotations } = await createHarness();
    ghGet.mockResolvedValue({ status: 200, data: fullWarningPage() });

    await expect(
      fetchAnnotations(
        'owner',
        'repo',
        42,
        testLogger(),
        new AnnotationFetchBudget(1, 60_000),
      ),
    ).rejects.toThrow('Annotation fetch budget exhausted');

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
