// Third-party imports
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Local imports - tools
import { DEFAULT_CHECK_ANNOTATION_LEVEL } from '@tools/github/checkAnnotationLevels';
import { GitHubRateLimitError } from '@tools/github/githubClient';
import {
  PRPollingSource,
  prKeyToString,
  type PRSubscriptionState,
} from '@tools/github/PRPollingSource';
import type { GhCheckAnnotation, GhCheckRun } from '@tools/github/prTypes';

// Local imports - test support
import {
  createPRCurrentShaState,
  createPRSubscriptionState,
} from '../support/prPollingSourceState';

const mocks = vi.hoisted(() => ({
  fetchAnnotations: vi.fn(),
}));

// Stub the annotation-fetch infrastructure at the module boundary rather than
// replacing the source's private delegator method.
vi.mock('@tools/github/checkRunsClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tools/github/checkRunsClient')>()),
  fetchAnnotations: mocks.fetchAnnotations,
}));

/**
 * The private drain surface these tests must still reach: there is no public
 * seam for draining annotation queues on demand or reading a subscription's
 * state. `subscribe`/`updateSubscription`/`has` are public and used directly.
 */
interface AnnotationDrainAccess {
  drainAnnotationQueues(
    entries: ReadonlyArray<readonly [string, PRSubscriptionState]>,
    now?: number,
  ): Promise<void>;
  getSubscriptionState(key: string): PRSubscriptionState | undefined;
}

function drainAccess(source: PRPollingSource): AnnotationDrainAccess {
  return source as unknown as AnnotationDrainAccess;
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

function createDrainState(runs: GhCheckRun[]): PRSubscriptionState {
  return createPRSubscriptionState({
    currentShaState: createPRCurrentShaState('abcdef1234567890', {
      pendingAnnotationRuns: runs,
    }),
  });
}

/** A source whose subscription states stay active for the whole drain. */
function createDrainSource(): PRPollingSource {
  const source = new PRPollingSource();
  source.has = vi.fn().mockReturnValue(true);
  return source;
}

describe('PRPollingSource annotation drain', () => {
  beforeEach(() => {
    PRPollingSource.resetAnnotationFetchBudgetForTests();
    mocks.fetchAnnotations.mockReset();
  });

  it('applies the base poller backoff path for annotation rate limits', async () => {
    const source = createDrainSource();
    const run = createCheckRun(42);
    const state = createDrainState([run]);
    const rateLimit = new GitHubRateLimitError(1_800_000_000);
    mocks.fetchAnnotations.mockRejectedValue(rateLimit);

    await drainAccess(source).drainAnnotationQueues([['owner/repo#7', state]]);

    expect(mocks.fetchAnnotations).toHaveBeenCalledWith(
      'owner',
      'repo',
      42,
      expect.anything(),
      expect.anything(),
      expect.any(Number),
    );
    expect(state.currentShaState?.pendingAnnotationRuns).toEqual([run]);
    expect(state.skipPollUntilMs).toBe(1_800_000_000_000);
  });

  it('drains annotation queues in fair passes across subscriptions', async () => {
    const source = createDrainSource();
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
    mocks.fetchAnnotations.mockResolvedValue([]);

    await drainAccess(source).drainAnnotationQueues([
      ['first', firstState],
      ['second', secondState],
      ['third', thirdState],
    ]);

    expect(mocks.fetchAnnotations.mock.calls.map((call) => call[2])).toEqual([
      1, 4, 7, 2, 5, 8, 3, 6, 9,
    ]);
    for (const state of [firstState, secondState, thirdState]) {
      expect(state.currentShaState?.pendingAnnotationRuns).toEqual([]);
    }
  });

  it('filters check annotations by each listener minimum level', async () => {
    const source = createDrainSource();
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
    mocks.fetchAnnotations.mockResolvedValue([
      annotation('notice', 'advisory note'),
      annotation('warning', 'format warning'),
      annotation('failure', 'blocking failure'),
    ]);

    await drainAccess(source).drainAnnotationQueues([['owner/repo#7', state]]);

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
    const source = new PRPollingSource();
    const pr = { owner: 'owner', repo: 'repo', pullNumber: 7 };
    const listener = vi.fn();
    const disposable = source.subscribe(pr, listener);
    const key = prKeyToString(pr);
    const state = drainAccess(source).getSubscriptionState(key);
    if (!state) throw new Error('Expected subscription state');
    mocks.fetchAnnotations.mockResolvedValue([
      annotation('warning', 'format warning'),
    ]);

    state.currentShaState = createPRCurrentShaState('abcdef1234567890', {
      pendingAnnotationRuns: [createCheckRun(13)],
    });
    await drainAccess(source).drainAnnotationQueues([[key, state]]);

    expect(listener).not.toHaveBeenCalled();

    source.updateSubscription(
      { ...pr, minAnnotationLevel: 'warning' },
      listener,
    );
    state.currentShaState = createPRCurrentShaState('abcdef1234567890', {
      pendingAnnotationRuns: [createCheckRun(14)],
    });

    await drainAccess(source).drainAnnotationQueues([[key, state]]);

    expect(listener).toHaveBeenCalledOnce();
    expect(listener.mock.calls[0][0]).toContain('[WARNING]');
    disposable.dispose();
  });
});
