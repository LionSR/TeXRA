// Third-party imports
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Local imports - tools
import { GitHubRateLimitError } from '@tools/github/githubClient';
import { PRPollingSource } from '@tools/github/PRPollingSource';
import type { GhCheckRun } from '@tools/github/prTypes';

interface AnnotationDrainState {
  pr: { owner: string; repo: string; pullNumber: number };
  slug: string;
  listeners: Set<(text: string) => void>;
  pendingAnnotationRuns: GhCheckRun[];
  lastSuccessAt: number;
  consecutiveFailures: number;
  skipPollUntilMs: number;
}

interface AnnotationDrainSource {
  drainAnnotationQueues(
    entries: ReadonlyArray<readonly [string, AnnotationDrainState]>,
    now?: number,
  ): Promise<void>;
  fetchAnnotations(
    owner: string,
    repo: string,
    checkRunId: number,
  ): Promise<unknown[]>;
  has(key: string): boolean;
}

function createCheckRun(id: number): GhCheckRun {
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

function createDrainState(runs: GhCheckRun[]): AnnotationDrainState {
  return {
    pr: { owner: 'owner', repo: 'repo', pullNumber: 7 },
    slug: 'owner/repo',
    listeners: new Set(),
    pendingAnnotationRuns: runs,
    lastSuccessAt: Date.now(),
    consecutiveFailures: 0,
    skipPollUntilMs: 0,
  };
}

function keepTestStatesActive(source: AnnotationDrainSource): void {
  source.has = vi.fn().mockReturnValue(true);
}

describe('PRPollingSource annotation drain', () => {
  beforeEach(() => {
    PRPollingSource.resetAnnotationFetchBudgetForTests();
  });

  it('applies the base poller backoff path for annotation rate limits', async () => {
    const source = new PRPollingSource() as unknown as AnnotationDrainSource;
    keepTestStatesActive(source);
    const run = createCheckRun(42);
    const state = createDrainState([run]);
    const rateLimit = new GitHubRateLimitError(1_800_000_000);
    source.fetchAnnotations = vi.fn().mockRejectedValue(rateLimit);

    await source.drainAnnotationQueues([['owner/repo#7', state]]);

    expect(source.fetchAnnotations).toHaveBeenCalledWith('owner', 'repo', 42);
    expect(state.pendingAnnotationRuns).toEqual([run]);
    expect(state.skipPollUntilMs).toBe(1_800_000_000_000);
  });

  it('shares the annotation fetch budget across source instances', async () => {
    PRPollingSource.resetAnnotationFetchBudgetForTests(4);
    const firstSource =
      new PRPollingSource() as unknown as AnnotationDrainSource;
    const secondSource =
      new PRPollingSource() as unknown as AnnotationDrainSource;
    keepTestStatesActive(firstSource);
    keepTestStatesActive(secondSource);
    const firstRuns = [createCheckRun(1), createCheckRun(2), createCheckRun(3)];
    const secondRuns = [
      createCheckRun(4),
      createCheckRun(5),
      createCheckRun(6),
    ];
    const firstState = createDrainState(firstRuns);
    const secondState = createDrainState(secondRuns);
    firstSource.fetchAnnotations = vi.fn().mockResolvedValue([]);
    secondSource.fetchAnnotations = vi.fn().mockResolvedValue([]);

    await firstSource.drainAnnotationQueues([['first', firstState]]);
    await secondSource.drainAnnotationQueues([['second', secondState]]);

    expect(firstSource.fetchAnnotations).toHaveBeenCalledTimes(3);
    expect(secondSource.fetchAnnotations).toHaveBeenCalledTimes(1);
    expect(firstState.pendingAnnotationRuns).toEqual([]);
    expect(secondState.pendingAnnotationRuns).toEqual([
      secondRuns[1],
      secondRuns[2],
    ]);
  });

  it('keeps queued annotation runs when the process budget is exhausted', async () => {
    PRPollingSource.resetAnnotationFetchBudgetForTests(0);
    const source = new PRPollingSource() as unknown as AnnotationDrainSource;
    keepTestStatesActive(source);
    const runs = [createCheckRun(7), createCheckRun(8)];
    const state = createDrainState(runs);
    source.fetchAnnotations = vi.fn().mockResolvedValue([]);

    await source.drainAnnotationQueues([['owner/repo#7', state]]);

    expect(source.fetchAnnotations).not.toHaveBeenCalled();
    expect(state.pendingAnnotationRuns).toEqual(runs);
  });

  it('refills the process budget after the fixed budget window', async () => {
    const now = 1_800_000_000_000;
    PRPollingSource.resetAnnotationFetchBudgetForTests(1, now);
    const source = new PRPollingSource() as unknown as AnnotationDrainSource;
    keepTestStatesActive(source);
    const runs = [createCheckRun(10), createCheckRun(11)];
    const state = createDrainState(runs);
    source.fetchAnnotations = vi.fn().mockResolvedValue([]);

    await source.drainAnnotationQueues([['owner/repo#7', state]], now);
    await source.drainAnnotationQueues([['owner/repo#7', state]], now + 29_999);
    await source.drainAnnotationQueues([['owner/repo#7', state]], now + 30_000);

    expect(
      vi.mocked(source.fetchAnnotations).mock.calls.map((call) => call[2]),
    ).toEqual([10, 11]);
    expect(state.pendingAnnotationRuns).toEqual([]);
  });

  it('drains annotation queues in fair passes across subscriptions', async () => {
    PRPollingSource.resetAnnotationFetchBudgetForTests(4);
    const source = new PRPollingSource() as unknown as AnnotationDrainSource;
    keepTestStatesActive(source);
    const firstState = createDrainState([
      createCheckRun(1),
      createCheckRun(2),
      createCheckRun(3),
    ]);
    const secondState = createDrainState([
      createCheckRun(4),
      createCheckRun(5),
      createCheckRun(6),
    ]);
    const thirdState = createDrainState([
      createCheckRun(7),
      createCheckRun(8),
      createCheckRun(9),
    ]);
    source.fetchAnnotations = vi.fn().mockResolvedValue([]);

    await source.drainAnnotationQueues([
      ['first', firstState],
      ['second', secondState],
      ['third', thirdState],
    ]);

    expect(
      vi.mocked(source.fetchAnnotations).mock.calls.map((call) => call[2]),
    ).toEqual([1, 4, 7, 2]);
    expect(firstState.pendingAnnotationRuns.map((run) => run.id)).toEqual([3]);
    expect(secondState.pendingAnnotationRuns.map((run) => run.id)).toEqual([
      5, 6,
    ]);
    expect(thirdState.pendingAnnotationRuns.map((run) => run.id)).toEqual([
      8, 9,
    ]);

    PRPollingSource.resetAnnotationFetchBudgetForTests(4);
    await source.drainAnnotationQueues([
      ['first', firstState],
      ['second', secondState],
      ['third', thirdState],
    ]);

    expect(
      vi.mocked(source.fetchAnnotations).mock.calls.map((call) => call[2]),
    ).toEqual([1, 4, 7, 2, 5, 8, 3, 6]);
  });
});
