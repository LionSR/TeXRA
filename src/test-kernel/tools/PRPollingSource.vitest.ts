// Third-party imports
import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { beforeEach, describe, expect, vi } from 'vitest';

// Local imports - tools
import { GitHubRateLimitError } from '@texra/tools/github/githubClient';
import type { PollHookRejected } from '@texra/tools/github/PollingSourceBase';
import {
  PRPollingSource,
  type PRSubscriptionState,
} from '@texra/tools/github/PRPollingSource';
import type { GhCheckRun } from '@texra/tools/github/prTypes';

// Local imports - test fixtures
import {
  createPRCurrentShaState,
  createPRSubscriptionState,
} from '../support/prPollingSourceState';

const mocks = vi.hoisted(() => ({
  fetchAnnotations: vi.fn(),
}));

// Stub the annotation-fetch infrastructure at the module boundary rather than
// replacing the source's private delegator method.
vi.mock('@texra/tools/github/checkRunsClient', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('@texra/tools/github/checkRunsClient')
  >()),
  fetchAnnotations: mocks.fetchAnnotations,
}));

/**
 * The private drain surface these tests must still reach: there is no public
 * seam for draining annotation queues on demand or reading a subscription's
 * state.
 */
interface AnnotationDrainAccess {
  drainAnnotationQueues(
    entries: ReadonlyArray<readonly [string, PRSubscriptionState]>,
    now?: number,
  ): Effect.Effect<void, PollHookRejected>;
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

function createDrainState(runs: GhCheckRun[]): PRSubscriptionState {
  return createPRSubscriptionState({
    currentShaState: createPRCurrentShaState('abcdef1234567890', {
      pendingAnnotationRuns: runs,
    }),
  });
}

/** A source whose subscription states stay active for the whole drain. */
function createDrainSource(): PRPollingSource {
  const source = new PRPollingSource(undefined, Effect.void);
  source.has = vi.fn().mockReturnValue(true);
  return source;
}

describe('PRPollingSource annotation drain', () => {
  beforeEach(() => {
    mocks.fetchAnnotations.mockReset();
  });

  it.effect(
    'applies the base poller backoff path for annotation rate limits',
    () =>
      Effect.gen(function* () {
        const source = createDrainSource();
        const run = createCheckRun(42);
        const state = createDrainState([run]);
        const rateLimit = new GitHubRateLimitError({ resetAt: 1_800_000_000 });
        mocks.fetchAnnotations.mockReturnValue(Effect.fail(rateLimit));

        yield* drainAccess(source).drainAnnotationQueues([
          ['owner/repo#7', state],
        ]);

        expect(state.currentShaState?.pendingAnnotationRuns).toEqual([run]);
        expect(state.skipPollUntilMs).toBe(1_800_000_000_000);
      }),
  );
});
