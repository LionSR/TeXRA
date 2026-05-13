// Third-party imports
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Local imports - tools
import {
  DEFAULT_CHECK_ANNOTATION_LEVEL,
  type GitHubCheckAnnotationLevel,
} from '@tools/github/checkAnnotationLevels';
import { GitHubRateLimitError } from '@tools/github/githubClient';
import {
  PRPollingSource,
  prKeyToString,
  type PRSubscribeInput,
} from '@tools/github/PRPollingSource';
import type { GhCheckAnnotation, GhCheckRun } from '@tools/github/prTypes';

interface AnnotationDrainState {
  pr: { owner: string; repo: string; pullNumber: number };
  slug: string;
  listeners: Set<(text: string) => void>;
  annotationLevelByListener: Map<
    (text: string) => void,
    GitHubCheckAnnotationLevel
  >;
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
    now?: number,
  ): Promise<unknown[]>;
  subscribe(
    input: PRSubscribeInput,
    onEvent: (text: string) => void,
  ): { dispose(): void };
  updateSubscription(
    input: PRSubscribeInput,
    onEvent: (text: string) => void,
  ): void;
  getSubscriptionState(key: string): AnnotationDrainState | undefined;
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

function annotation(
  level: GhCheckAnnotation['annotation_level'],
  message: string,
): GhCheckAnnotation {
  return {
    path: 'blueprint/src/chapter.tex',
    start_line: 12,
    end_line: 12,
    annotation_level: level,
    message,
  };
}

function createDrainState(runs: GhCheckRun[]): AnnotationDrainState {
  return {
    pr: { owner: 'owner', repo: 'repo', pullNumber: 7 },
    slug: 'owner/repo',
    listeners: new Set(),
    annotationLevelByListener: new Map(),
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

    expect(source.fetchAnnotations).toHaveBeenCalledWith(
      'owner',
      'repo',
      42,
      expect.any(Number),
    );
    expect(state.pendingAnnotationRuns).toEqual([run]);
    expect(state.skipPollUntilMs).toBe(1_800_000_000_000);
  });

  it('drains annotation queues in fair passes across subscriptions', async () => {
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
    ).toEqual([1, 4, 7, 2, 5, 8, 3, 6, 9]);
    expect(firstState.pendingAnnotationRuns.map((run) => run.id)).toEqual([]);
    expect(secondState.pendingAnnotationRuns.map((run) => run.id)).toEqual([]);
    expect(thirdState.pendingAnnotationRuns.map((run) => run.id)).toEqual([]);
  });

  it('filters check annotations by each listener minimum level', async () => {
    PRPollingSource.resetAnnotationFetchBudgetForTests();
    const source = new PRPollingSource() as unknown as AnnotationDrainSource;
    keepTestStatesActive(source);
    const run = createCheckRun(12);
    const state = createDrainState([run]);
    const defaultListener = vi.fn();
    const warningListener = vi.fn();
    const noticeListener = vi.fn();
    state.listeners.add(defaultListener);
    state.listeners.add(warningListener);
    state.listeners.add(noticeListener);
    state.annotationLevelByListener.set(
      defaultListener,
      DEFAULT_CHECK_ANNOTATION_LEVEL,
    );
    state.annotationLevelByListener.set(warningListener, 'warning');
    state.annotationLevelByListener.set(noticeListener, 'notice');
    source.fetchAnnotations = vi
      .fn()
      .mockResolvedValue([
        annotation('notice', 'advisory note'),
        annotation('warning', 'format warning'),
        annotation('failure', 'blocking failure'),
      ]);

    await source.drainAnnotationQueues([['owner/repo#7', state]]);

    expect(defaultListener).toHaveBeenCalledOnce();
    const defaultMessage = defaultListener.mock.calls[0][0] as string;
    expect(defaultMessage).toContain('[FAILURE]');
    expect(defaultMessage).not.toContain('[WARNING]');
    expect(defaultMessage).not.toContain('[NOTICE]');

    expect(warningListener).toHaveBeenCalledOnce();
    const warningMessage = warningListener.mock.calls[0][0] as string;
    expect(warningMessage).toContain('[WARNING]');
    expect(warningMessage).toContain('[FAILURE]');
    expect(warningMessage).not.toContain('[NOTICE]');

    expect(noticeListener).toHaveBeenCalledOnce();
    const noticeMessage = noticeListener.mock.calls[0][0] as string;
    expect(noticeMessage).toContain('[NOTICE]');
    expect(noticeMessage).toContain('[WARNING]');
    expect(noticeMessage).toContain('[FAILURE]');
  });

  it('updates the annotation level for an existing listener', async () => {
    PRPollingSource.resetAnnotationFetchBudgetForTests();
    const source = new PRPollingSource() as unknown as AnnotationDrainSource;
    const pr = { owner: 'owner', repo: 'repo', pullNumber: 7 };
    const listener = vi.fn();
    const disposable = source.subscribe(pr, listener);
    const key = prKeyToString(pr);
    const state = source.getSubscriptionState(key);
    expect(state).toBeTruthy();
    if (!state) throw new Error('Expected subscription state');
    source.fetchAnnotations = vi
      .fn()
      .mockResolvedValue([annotation('warning', 'format warning')]);

    state.pendingAnnotationRuns = [createCheckRun(13)];
    await source.drainAnnotationQueues([[key, state]]);

    expect(listener).not.toHaveBeenCalled();

    source.updateSubscription(
      { ...pr, minAnnotationLevel: 'warning' },
      listener,
    );
    state.pendingAnnotationRuns = [createCheckRun(14)];

    await source.drainAnnotationQueues([[key, state]]);

    expect(listener).toHaveBeenCalledOnce();
    expect(listener.mock.calls[0][0]).toContain('[WARNING]');
    disposable.dispose();
  });
});
